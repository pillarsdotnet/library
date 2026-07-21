'use strict';
// Drag the four corners of a cover, then flatten it.
//
// Automatic corner-finding is right often enough to be worth offering and wrong
// often enough that it cannot be trusted on its own — on a cover whose own edge
// is fainter than the lines in its artwork, no amount of tuning finds it. This
// is the answer to that: whatever the detector guessed, four handles put it
// right, and the perspective correction is the same either way.
(function attachCorners() {
  const HANDLE = 13;        // drawn radius
  const TOUCH_SLOP = 34;    // how near a finger must land to grab a handle

  let canvas = null;
  let ctx = null;
  let image = null;         // the photo, at natural size
  let points = [];          // corners in natural-image coordinates
  let scale = 1;            // natural -> canvas
  let dragging = -1;
  let onChange = null;

  const toCanvas = (p) => ({ x: p.x * scale, y: p.y * scale });
  const toImage = (x, y) => ({ x: x / scale, y: y / scale });

  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);

    const pts = points.map(toCanvas);
    // Dim everything outside the quad, so the crop reads at a glance.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 3; i >= 1; i -= 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill('evenodd');
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    for (const [i, p] of pts.entries()) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE, 0, Math.PI * 2);
      ctx.fillStyle = i === dragging ? 'rgba(77, 163, 255, 0.9)' : 'rgba(255, 255, 255, 0.9)';
      ctx.fill();
      ctx.strokeStyle = '#2b6cb0';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function nearest(x, y) {
    let best = -1, bestDist = TOUCH_SLOP;
    points.map(toCanvas).forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  const pointerPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  };

  function onDown(e) {
    const { x, y } = pointerPos(e);
    dragging = nearest(x, y);
    if (dragging < 0) return;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    draw();
  }

  function onMove(e) {
    if (dragging < 0) return;
    const { x, y } = pointerPos(e);
    const p = toImage(
      Math.max(0, Math.min(canvas.width, x)),
      Math.max(0, Math.min(canvas.height, y)),
    );
    points[dragging] = p;
    e.preventDefault();
    draw();
    if (onChange) onChange(points.map((q) => ({ ...q })));
  }

  function onUp(e) {
    if (dragging < 0) return;
    dragging = -1;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    draw();
  }

  // Start editing. `quad` may come from the detector; without one, an inset
  // rectangle gives four handles that are easy to find and drag.
  //
  // The canvas has to fit the space in *both* directions. Sizing it on width
  // alone made a portrait photo taller than the area it sits in, and the crop
  // area clips what overflows — so the bottom two handles were off the bottom
  // of the box, undraggable, on exactly the phone-shaped screens this tool is
  // for. Fit like `contain`, not like `width: 100%`.
  function open(canvasEl, img, quad, maxWidth, maxHeight) {
    canvas = canvasEl;
    image = img;
    const natural = { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
    scale = Math.min(
      1,
      (maxWidth || natural.w) / natural.w,
      (maxHeight || natural.h) / natural.h,
    );
    canvas.width = Math.max(1, Math.round(natural.w * scale));
    canvas.height = Math.max(1, Math.round(natural.h * scale));
    ctx = canvas.getContext('2d');

    points = quad && quad.length === 4
      ? quad.map((p) => ({ x: p.x, y: p.y }))
      : [
        { x: natural.w * 0.1, y: natural.h * 0.1 }, { x: natural.w * 0.9, y: natural.h * 0.1 },
        { x: natural.w * 0.9, y: natural.h * 0.9 }, { x: natural.w * 0.1, y: natural.h * 0.9 },
      ];

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    draw();
  }

  function close() {
    if (!canvas) return;
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas = null; ctx = null; image = null; dragging = -1;
  }

  const corners = () => points.map((p) => ({ ...p }));

  // Flatten the marked quad, using the same perspective correction as auto-crop.
  function flatten() {
    if (!image || points.length !== 4) return null;
    return window.AutoCrop ? window.AutoCrop.warp(image, corners()) : null;
  }

  window.CornerEditor = { open, close, corners, flatten, draw, set onChange(fn) { onChange = fn; } };
}());
