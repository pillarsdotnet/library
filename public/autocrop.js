'use strict';
// Document-scanner style auto-crop: find the rectangular object (a book cover)
// in a photo and flatten it, correcting for the camera being off-square.
// Deliberately dependency-free — an OpenCV build would dwarf the whole app.
(function attachAutoCrop() {
  const WORK_WIDTH = 480;   // detection runs on a downscale; plenty for finding edges
  const MIN_AREA = 0.10;    // ignore specks
  const MAX_AREA = 0.98;    // ...and "the object fills the frame", where cropping is moot

  // --- image → binary mask -------------------------------------------------

  function toGray({ data, width, height }) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
    }
    return gray;
  }

  // Otsu: pick the threshold that best separates the histogram into two classes.
  function otsuThreshold(gray) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
    const total = gray.length;
    let sum = 0;
    for (let t = 0; t < 256; t += 1) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (let t = 0; t < 256; t += 1) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = t; }
    }
    return best;
  }

  // The object is whichever class does NOT dominate the border of the frame.
  function objectMask(gray, w, h) {
    const t = otsuThreshold(gray);
    let brightBorder = 0, borderCount = 0;
    const sample = (x, y) => { brightBorder += gray[y * w + x] > t ? 1 : 0; borderCount += 1; };
    for (let x = 0; x < w; x += 1) { sample(x, 0); sample(x, h - 1); }
    for (let y = 0; y < h; y += 1) { sample(0, y); sample(w - 1, y); }
    const objectIsBright = brightBorder / borderCount < 0.5;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i += 1) {
      mask[i] = (gray[i] > t) === objectIsBright ? 1 : 0;
    }
    return mask;
  }

  // Largest 4-connected blob, returned as its per-row horizontal extents (which
  // bound the shape tightly enough to recover corners from).
  function largestBlob(mask, w, h) {
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let best = null;
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || seen[start]) continue;
      let sp = 0, area = 0;
      stack[sp++] = start;
      seen[start] = 1;
      const rows = new Map();   // y -> [minX, maxX]
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        area += 1;
        const r = rows.get(y);
        if (!r) rows.set(y, [x, x]);
        else { if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; }
        if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (!best || area > best.area) best = { area, rows };
    }
    return best;
  }

  // --- blob → quadrilateral ------------------------------------------------

  // For a convex-ish shape the corners are the extremes of (x+y) and (x-y).
  function cornersFrom(rows) {
    let tl = null, br = null, tr = null, bl = null;
    const consider = (x, y) => {
      const sum = x + y, diff = x - y;
      if (!tl || sum < tl.x + tl.y) tl = { x, y };
      if (!br || sum > br.x + br.y) br = { x, y };
      if (!tr || diff > tr.x - tr.y) tr = { x, y };
      if (!bl || diff < bl.x - bl.y) bl = { x, y };
    };
    rows.forEach(([minX, maxX], y) => { consider(minX, y); consider(maxX, y); });
    return [tl, tr, br, bl];
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function quadArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i += 1) {
      const p = q[i], n = q[(i + 1) % 4];
      a += p.x * n.y - n.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  // Find the cover's corners. Returns 4 points in source-image coordinates
  // (top-left, top-right, bottom-right, bottom-left) or null if unconvincing.
  function detectQuad(imageData) {
    const { width: w, height: h } = imageData;
    const gray = toGray(imageData);
    const mask = objectMask(gray, w, h);
    const blob = largestBlob(mask, w, h);
    if (!blob) return null;

    const frame = w * h;
    if (blob.area < frame * MIN_AREA || blob.area > frame * MAX_AREA) return null;

    const quad = cornersFrom(blob.rows);
    if (quad.some((p) => !p)) return null;
    // Every corner distinct, and the quad should account for most of the blob —
    // otherwise the shape isn't really a quadrilateral.
    for (let i = 0; i < 4; i += 1) {
      for (let j = i + 1; j < 4; j += 1) if (dist(quad[i], quad[j]) < 8) return null;
    }
    const area = quadArea(quad);
    if (area < frame * MIN_AREA || area < blob.area * 0.7) return null;
    return quad;
  }

  // --- perspective correction ---------------------------------------------

  // Solve the 3x3 homography taking the four `from` points to the four `to`
  // points (standard 8-unknown DLT, solved by Gaussian elimination).
  function solveHomography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i += 1) {
      const { x, y } = from[i], { x: X, y: Y } = to[i];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    for (let col = 0; col < 8; col += 1) {                  // forward elimination
      let piv = col;
      for (let r = col + 1; r < 8; r += 1) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-9) return null;
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
      for (let r = 0; r < 8; r += 1) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        if (!f) continue;
        for (let c = col; c < 8; c += 1) A[r][c] -= f * A[col][c];
        b[r] -= f * b[col];
      }
    }
    const hh = A.map((row, i) => b[i] / row[i]);
    return [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1];
  }

  // Flatten `quad` out of `source` into a straight rectangle.
  function warp(source, quad, maxSide = 1400) {
    const wTop = dist(quad[0], quad[1]), wBottom = dist(quad[3], quad[2]);
    const hLeft = dist(quad[0], quad[3]), hRight = dist(quad[1], quad[2]);
    let outW = Math.round(Math.max(wTop, wBottom));
    let outH = Math.round(Math.max(hLeft, hRight));
    if (!outW || !outH) return null;
    const scale = Math.min(1, maxSide / Math.max(outW, outH));
    outW = Math.max(1, Math.round(outW * scale));
    outH = Math.max(1, Math.round(outH * scale));

    // Map destination pixels back into the source (inverse warp + bilinear).
    const H = solveHomography(
      [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }],
      quad,
    );
    if (!H) return null;

    const sc = document.createElement('canvas');
    sc.width = source.width; sc.height = source.height;
    sc.getContext('2d').drawImage(source, 0, 0);
    const src = sc.getContext('2d').getImageData(0, 0, source.width, source.height);
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const ctx = out.getContext('2d');
    const dst = ctx.createImageData(outW, outH);
    const sw = src.width, sh = src.height;

    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        const den = H[6] * x + H[7] * y + H[8];
        const sx = (H[0] * x + H[1] * y + H[2]) / den;
        const sy = (H[3] * x + H[4] * y + H[5]) / den;
        const di = (y * outW + x) * 4;
        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) { dst.data[di + 3] = 255; continue; }
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = sx - x0, fy = sy - y0;
        for (let c = 0; c < 3; c += 1) {
          const p00 = src.data[(y0 * sw + x0) * 4 + c], p10 = src.data[(y0 * sw + x1) * 4 + c];
          const p01 = src.data[(y1 * sw + x0) * 4 + c], p11 = src.data[(y1 * sw + x1) * 4 + c];
          dst.data[di + c] = (p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy)
            + p01 * (1 - fx) * fy + p11 * fx * fy) | 0;
        }
        dst.data[di + 3] = 255;
      }
    }
    ctx.putImageData(dst, 0, 0);
    return out;
  }

  // Detect and flatten in one go. Returns { canvas, quad } or null when no
  // convincing rectangle was found (in which case: leave the photo alone).
  function autoCrop(image) {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (!w || !h) return null;

    const scale = Math.min(1, WORK_WIDTH / w);
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    small.getContext('2d').drawImage(image, 0, 0, sw, sh);

    const quad = detectQuad(small.getContext('2d').getImageData(0, 0, sw, sh));
    if (!quad) return null;

    const full = quad.map((p) => ({ x: p.x / scale, y: p.y / scale }));
    const canvas = warp(image, full);
    return canvas ? { canvas, quad: full } : null;
  }

  window.AutoCrop = { autoCrop, detectQuad, warp, solveHomography };
}());
