'use strict';
// Document-scanner style auto-crop: find the rectangular object (a book cover)
// in a photo and flatten it, correcting for the camera being off-square.
// Deliberately dependency-free — an OpenCV build would dwarf the whole app.
//
// A single global threshold is not enough. Photographed on a paper bag on a
// table, the bag is a big bright rectangle too, and a brightness-only pass
// crops to the bag; worse, a brown bag and a green cover can share a brightness
// exactly where their boundary is. So: gradients per colour channel, candidate
// quadrilaterals from both region thresholds and straight edges (Hough), and
// one judgement to choose between them — a book cover is busy inside and rests
// on a calm surface, which the bag beneath it is not, and a rectangle cut
// through the cover art is not either.
(function attachAutoCrop() {
  const WORK_WIDTH = 360;   // detection runs on a downscale; plenty for finding edges
  const MIN_AREA = 0.12;    // ignore specks and cover-art blocks
  const MAX_AREA = 0.98;    // ...and "the object fills the frame", where cropping is moot
  const MIN_SIDE_SUPPORT = 0.30; // every side must sit on a real edge, not a guess
  const MIN_INTERIOR = 0.04;   // a cover has lettering and a picture; a mat has neither
  const MIN_CONTRAST = 2.0;    // busy-inside vs calm-outside ratio needed to act at all
  const COVERAGE_RATIO = 0.7;  // how evenly printed, next to the best candidate
  const THRESHOLD_PERCENTILES = [20, 30, 40, 50, 60, 70, 80];

  // --- image → gray, edges ------------------------------------------------

  function toGray({ data, width, height }) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
    }
    return gray;
  }

  const histogram = (gray) => {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
    return hist;
  };

  // Otsu: pick the threshold that best separates the histogram into two classes.
  function otsuThreshold(gray) {
    const hist = histogram(gray);
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

  // Brightness levels below which the given percentages of pixels fall.
  function percentileThresholds(gray, percentiles) {
    const hist = histogram(gray);
    const out = [];
    let seen = 0, level = 0;
    for (const pct of percentiles) {
      const target = (gray.length * pct) / 100;
      while (level < 255 && seen + hist[level] < target) { seen += hist[level]; level += 1; }
      out.push(level);
    }
    return out;
  }

  // Sobel gradient magnitude — how much of an edge is at each pixel. Run per
  // colour channel and keep the strongest: a brown bag and the green cover
  // lying on it can be the same brightness, and a luminance-only pass is blind
  // to exactly the edge we are looking for.
  function sobel({ data, width: w, height: h }) {
    const g = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        const p = i * 4;
        let best = 0;
        for (let c = 0; c < 3; c += 1) {
          const nw = data[p - w * 4 - 4 + c], n = data[p - w * 4 + c], ne = data[p - w * 4 + 4 + c];
          const we = data[p - 4 + c], ea = data[p + 4 + c];
          const sw = data[p + w * 4 - 4 + c], so = data[p + w * 4 + c], se = data[p + w * 4 + 4 + c];
          const gx = -nw - 2 * we - sw + ne + 2 * ea + se;
          const gy = -nw - 2 * n - ne + sw + 2 * so + se;
          const m = Math.hypot(gx, gy);
          if (m > best) best = m;
        }
        g[i] = best;
      }
    }
    return g;
  }

  // Scale gradients against a strong-but-not-freak value, so "support" is
  // comparable between a crisp photo and a dim one.
  function gradientScale(grad) {
    let max = 0;
    for (let i = 0; i < grad.length; i += 1) if (grad[i] > max) max = grad[i];
    if (!max) return 1;
    const bins = new Int32Array(64);
    for (let i = 0; i < grad.length; i += 1) bins[Math.min(63, (grad[i] / max * 63) | 0)] += 1;
    let seen = 0;
    const target = grad.length * 0.98;
    for (let b = 0; b < 64; b += 1) {
      seen += bins[b];
      if (seen >= target) return Math.max(1, ((b + 1) / 64) * max);
    }
    return max;
  }

  // --- threshold → blob → quadrilateral ------------------------------------

  function maskAt(gray, t, objectIsBright) {
    const mask = new Uint8Array(gray.length);
    for (let i = 0; i < mask.length; i += 1) mask[i] = (gray[i] > t) === objectIsBright ? 1 : 0;
    return mask;
  }

  // Every 4-connected blob of at least `minArea` pixels, biggest first, each as
  // its per-row horizontal extents (which bound the shape tightly enough to
  // recover corners from). Not just the biggest: a book photographed on a paper
  // bag is the *second* biggest thing in the frame.
  function findBlobs(mask, w, h, minArea, keep = 4) {
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const found = [];
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
      if (area >= minArea) found.push({ area, rows });
    }
    found.sort((a, b) => b.area - a.area);
    return found.slice(0, keep);
  }

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

  // Corners should be roughly square-on: a perspective view of a rectangle
  // never folds a corner much past this.
  function anglesPlausible(q) {
    for (let i = 0; i < 4; i += 1) {
      const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      const a1 = Math.atan2(p.y - c.y, p.x - c.x);
      const a2 = Math.atan2(n.y - c.y, n.x - c.x);
      let deg = Math.abs((a1 - a2) * 180 / Math.PI) % 360;
      if (deg > 180) deg = 360 - deg;
      if (deg < 50 || deg > 130) return false;
    }
    return true;
  }

  // How much of a real edge lies under one side of the quad: walk the side and
  // take the strongest gradient within a couple of pixels either way.
  function sideSupport(grad, w, h, scale, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) return 0;
    const nx = -dy / len, ny = dx / len;
    const samples = 48;
    let sum = 0;
    for (let k = 0; k < samples; k += 1) {
      const t = 0.08 + 0.84 * (k / (samples - 1));   // skip the corners themselves
      const px = a.x + dx * t, py = a.y + dy * t;
      let best = 0;
      for (let d = -2; d <= 2; d += 1) {
        const x = Math.round(px + nx * d), y = Math.round(py + ny * d);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const v = grad[y * w + x];
        if (v > best) best = v;
      }
      sum += Math.min(1, best / scale);
    }
    return sum / samples;
  }

  // The weakest of the four sides: one vague side means we found a shading
  // boundary or a block of cover art, not the edge of a book.
  function quadSupport(grad, w, h, scale, q) {
    let worst = 1;
    for (let i = 0; i < 4; i += 1) {
      const s = sideSupport(grad, w, h, scale, q[i], q[(i + 1) % 4]);
      if (s < worst) worst = s;
    }
    return worst;
  }

  // --- candidate quads from straight edges ---------------------------------

  // Hough transform over the strong gradient pixels. Brightness thresholding
  // cannot separate a multicoloured cover from a similarly-toned background,
  // but the cover's four straight edges show up here whatever its colours.
  function houghLines(grad, w, h, scale, maxLines = 16) {
    const thetaBins = 90;                 // 2° apart
    const rhoMax = Math.ceil(Math.hypot(w, h));
    const rhoBins = Math.ceil((2 * rhoMax) / 2);
    const acc = new Float32Array(thetaBins * rhoBins);
    const cos = new Float32Array(thetaBins);
    const sin = new Float32Array(thetaBins);
    for (let t = 0; t < thetaBins; t += 1) {
      const a = (t * Math.PI) / thetaBins;
      cos[t] = Math.cos(a); sin[t] = Math.sin(a);
    }
    const minGrad = scale * 0.5;
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const g = grad[y * w + x];
        if (g < minGrad) continue;
        for (let t = 0; t < thetaBins; t += 1) {
          const r = (((x * cos[t] + y * sin[t]) + rhoMax) / 2) | 0;
          acc[t * rhoBins + r] += 1;
        }
      }
    }

    // How long this line's chord is inside the frame, so a short-but-solid edge
    // (the top of a book) can outrank a long faint one (a fold in the bag).
    const chord = (theta, rho) => {
      const c = Math.cos(theta), s = Math.sin(theta);
      const pts = [];
      if (Math.abs(s) > 1e-6) {
        for (const x of [0, w - 1]) {
          const y = (rho - x * c) / s;
          if (y >= 0 && y <= h - 1) pts.push([x, y]);
        }
      }
      if (Math.abs(c) > 1e-6) {
        for (const y of [0, h - 1]) {
          const x = (rho - y * s) / c;
          if (x >= 0 && x <= w - 1) pts.push([x, y]);
        }
      }
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    };

    // Peaks, with a little non-maximum suppression so one edge yields one line.
    const peaks = [];
    for (let t = 0; t < thetaBins; t += 1) {
      for (let r = 0; r < rhoBins; r += 1) {
        const v = acc[t * rhoBins + r];
        if (v < 20) continue;
        let isMax = true;
        for (let dt = -3; dt <= 3 && isMax; dt += 1) {
          const tt = (t + dt + thetaBins) % thetaBins;
          for (let dr = -4; dr <= 4; dr += 1) {
            const rr = r + dr;
            if (rr < 0 || rr >= rhoBins || (!dt && !dr)) continue;
            if (acc[tt * rhoBins + rr] > v) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        const theta = (t * Math.PI) / thetaBins, rho = r * 2 - rhoMax;
        const len = chord(theta, rho);
        if (len < 20) continue;
        peaks.push({ v: v / len, theta, rho });   // fraction of the chord that is edge
      }
    }
    peaks.sort((a, b) => b.v - a.v);
    return peaks.slice(0, maxLines);
  }

  // Where two lines in (rho, theta) form meet, or null if near-parallel.
  function intersect(l1, l2) {
    const c1 = Math.cos(l1.theta), s1 = Math.sin(l1.theta);
    const c2 = Math.cos(l2.theta), s2 = Math.sin(l2.theta);
    const det = c1 * s2 - c2 * s1;
    if (Math.abs(det) < 1e-6) return null;
    return { x: (l1.rho * s2 - l2.rho * s1) / det, y: (c1 * l2.rho - c2 * l1.rho) / det };
  }

  const angleGap = (a, b) => {
    let d = Math.abs(a - b) % Math.PI;
    return d > Math.PI / 2 ? Math.PI - d : d;
  };

  // Order four corners as top-left, top-right, bottom-right, bottom-left.
  function orderCorners(pts) {
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    const byAngle = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let start = 0;
    for (let i = 1; i < 4; i += 1) {
      if (byAngle[i].x + byAngle[i].y < byAngle[start].x + byAngle[start].y) start = i;
    }
    return [0, 1, 2, 3].map((i) => byAngle[(start + i) % 4]);
  }

  // Quads formed by two near-parallel lines crossing two others.
  function lineQuads(grad, w, h, scale) {
    const lines = houghLines(grad, w, h, scale);
    const pairs = [];
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (angleGap(lines[i].theta, lines[j].theta) < 0.22) pairs.push([lines[i], lines[j]]);
      }
    }
    const quads = [];
    const margin = 0.15;
    for (let a = 0; a < pairs.length; a += 1) {
      for (let b = a + 1; b < pairs.length; b += 1) {
        if (angleGap(pairs[a][0].theta, pairs[b][0].theta) < 1.0) continue;  // want ~perpendicular
        const pts = [];
        let ok = true;
        for (const p of pairs[a]) {
          for (const q of pairs[b]) {
            const it = intersect(p, q);
            if (!it || it.x < -margin * w || it.x > (1 + margin) * w
              || it.y < -margin * h || it.y > (1 + margin) * h) { ok = false; break; }
            pts.push(it);
          }
          if (!ok) break;
        }
        if (ok && pts.length === 4) quads.push(orderCorners(pts));
      }
    }
    return quads;
  }

  function insideQuad(q, x, y) {
    let hit = false;
    for (let i = 0, j = 3; i < 4; j = i, i += 1) {
      const a = q[i], b = q[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  }

  // Mean edge activity inside the quad. A book cover has lettering and a
  // picture; a patch of table, bag or mat has almost nothing.
  function interiorTexture(grad, w, h, scale, q) {
    const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    const step = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) / 40));
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        if (!insideQuad(q, x, y)) continue;
        sum += Math.min(1, grad[y * w + x] / scale);
        n += 1;
      }
    }
    return n ? sum / n : 0;
  }

  // What fraction of the inside is busy, rather than how busy it is on average.
  // A cover is printed all over; the bag under it is a wide calm expanse with
  // one busy patch (the book). Averages confuse the two — this does not.
  function interiorCoverage(grad, w, h, scale, q) {
    const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    const step = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) / 40));
    let busy = 0, n = 0;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        if (!insideQuad(q, x, y)) continue;
        // Look at a small neighbourhood: printing is busy at some scale, even
        // where a given pixel happens to sit in a plain patch of the picture.
        let peak = 0;
        for (let dy = -step; dy <= step; dy += step) {
          for (let dx = -step; dx <= step; dx += step) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            if (grad[yy * w + xx] > peak) peak = grad[yy * w + xx];
          }
        }
        if (peak / scale > 0.08) busy += 1;
        n += 1;
      }
    }
    return n ? busy / n : 0;
  }

  // Mean edge activity in the band just outside the quad. An object lying on a
  // surface has a calm border of table, bag or mat around it; a rectangle drawn
  // through the middle of the cover art has more artwork around it. This is what
  // stops the search descending from the book into a block of its own cover.
  function surroundTexture(grad, w, h, scale, q) {
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    let sum = 0, n = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = q[i], b = q[(i + 1) % 4];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 8) continue;
      let nx = -dy / len, ny = dx / len;
      // Point the normal away from the middle of the quad.
      if ((a.x + dx / 2 + nx - cx) ** 2 + (a.y + dy / 2 + ny - cy) ** 2
        < (a.x + dx / 2 - cx) ** 2 + (a.y + dy / 2 - cy) ** 2) { nx = -nx; ny = -ny; }
      for (let k = 0; k < 24; k += 1) {
        const t = 0.1 + 0.8 * (k / 23);
        for (let d = 4; d <= 12; d += 2) {
          const x = Math.round(a.x + dx * t + nx * d), y = Math.round(a.y + dy * t + ny * d);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;   // off-frame: no evidence either way
          sum += Math.min(1, grad[y * w + x] / scale);
          n += 1;
        }
      }
    }
    return n < 40 ? 1 : sum / n;   // too little of the border visible to judge
  }

  // Find the best object in this image: its corners (top-left, top-right,
  // bottom-right, bottom-left) plus the measurements that won it, or null.
  function detectBest(imageData) {
    const { width: w, height: h } = imageData;
    const frame = w * h;
    const gray = toGray(imageData);
    const grad = sobel(imageData);
    const scale = gradientScale(grad);

    const levels = [otsuThreshold(gray), ...percentileThresholds(gray, THRESHOLD_PERCENTILES)];
    const seenLevels = new Set();
    const candidates = [];
    const consider = (quad) => {
      let degenerate = false;
      for (let i = 0; i < 4 && !degenerate; i += 1) {
        for (let j = i + 1; j < 4; j += 1) if (dist(quad[i], quad[j]) < 8) { degenerate = true; break; }
      }
      if (degenerate) return;
      const area = quadArea(quad);
      if (area < frame * MIN_AREA || area > frame * MAX_AREA) return;
      if (!anglesPlausible(quad)) return;
      const support = quadSupport(grad, w, h, scale, quad);
      if (support < MIN_SIDE_SUPPORT) return;
      candidates.push({ quad, area, support });
    };

    for (const quad of lineQuads(grad, w, h, scale)) consider(quad);

    for (const t of levels) {
      if (seenLevels.has(t)) continue;
      seenLevels.add(t);
      for (const objectIsBright of [true, false]) {
        const blobs = findBlobs(maskAt(gray, t, objectIsBright), w, h, frame * MIN_AREA);
        for (const blob of blobs) {
          if (blob.area > frame * MAX_AREA) continue;

          const quad = cornersFrom(blob.rows);
          if (quad.some((p) => !p)) continue;
          // The quad must account for most of the blob, or the blob isn't one.
          if (quadArea(quad) < blob.area * 0.7) continue;
          consider(quad);
        }
      }
    }
    if (!candidates.length) return null;

    // One judgement decides it: a book cover is busy inside and sits on a calm
    // surface. The bag under the book is calm on both sides; a rectangle cut
    // through the cover art is busy on both. Only the cover itself is busy
    // inside and calm outside.
    const plausible = [];
    for (const c of candidates) {
      const inside = interiorTexture(grad, w, h, scale, c.quad);
      if (inside < MIN_INTERIOR) continue;
      const outside = surroundTexture(grad, w, h, scale, c.quad);
      const contrast = inside / Math.max(outside, 0.02);
      if (contrast < MIN_CONTRAST) continue;
      plausible.push({
        quad: c.quad, area: c.area, support: c.support, contrast,
        coverage: interiorCoverage(grad, w, h, scale, c.quad),
      });
    }
    if (!plausible.length) return null;

    // Prefer the *largest* thing that is printed throughout. Cropping too tight
    // silently eats the title, while cropping too loose leaves a margin the
    // cropper is already open for — so when in doubt, take in more. Ratios like
    // busy-inside-over-calm-outside are maximised by tight crops inside the
    // artwork, which is exactly the mistake to avoid.
    //
    // The bar for "printed throughout" is relative to the best candidate, not
    // an absolute figure: covers carry plain margins and plain bands, so what
    // counts as busy differs from cover to cover. What holds across them is
    // that the cover is more evenly printed than the bag or table it lies on.
    const bestCoverage = plausible.reduce((m, c) => Math.max(m, c.coverage), 0);
    const printed = plausible.filter((c) => c.coverage >= bestCoverage * COVERAGE_RATIO);
    printed.sort((a, b) => b.area - a.area);
    return printed[0];
  }

  // Public form: just the corners, or null.
  function detectQuad(imageData) {
    const best = detectBest(imageData);
    return best ? best.quad : null;
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
    const clamp = (v, hi) => (v < 0 ? 0 : (v > hi ? hi : v));

    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        const den = H[6] * x + H[7] * y + H[8];
        // Clamp rather than blanking: rounding at the border would otherwise
        // paint a black rim around an otherwise correct crop.
        const sx = clamp((H[0] * x + H[1] * y + H[2]) / den, sw - 1);
        const sy = clamp((H[3] * x + H[4] * y + H[5]) / den, sh - 1);
        const di = (y * outW + x) * 4;
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
