'use strict';

const $ = (sel) => document.querySelector(sel);
// Relative to the document <base>, so the app works under any mount path (/library).
const api = (path, opts) => fetch('api' + path, opts).then(async (r) => {
  if (!r.ok && r.status !== 204) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.status === 204 ? null : r.json();
});

const STATUS_LABELS = { tbr: 'To be read', reading: 'Reading', read: 'Read', loaned: 'Loaned out' };
const FORMAT_LABELS = { paperback: 'Paperback', hardback: 'Hardback', ebook: 'E-book', audiobook: 'Audiobook', other: 'Other' };
const SOURCE_LABELS = { openlibrary: 'Open Library', googlebooks: 'Google Books', barnesnoble: 'Barnes & Noble', bookofthemonth: 'Book of the Month', manual: 'Manual' };

// --- Units. Everything is stored in mm; the toggle only affects display/input. ---
const MM_PER_IN = 25.4;
const DIM_FIELDS = ['height_mm', 'width_mm', 'thickness_mm', 'depth_mm'];
let UNIT = localStorage.getItem('libUnit') === 'in' ? 'in' : 'mm';

const mmToUnit = (mm, unit = UNIT) =>
  (mm == null || mm === '') ? '' : (unit === 'in' ? Math.round((mm / MM_PER_IN) * 100) / 100 : Math.round(mm * 10) / 10);
const unitToMm = (v, unit = UNIT) =>
  (v === '' || v == null) ? '' : (unit === 'in' ? Number(v) * MM_PER_IN : Number(v));
const dispDim = (mm) => (mm == null ? '—' : mmToUnit(mm)); // for read-only display

const bookDialog = $('#editDialog');
const bookForm = $('#bookForm');
const shelfDialog = $('#shelfDialog');
const shelfForm = $('#shelfForm');
const genreDialog = $('#genreDialog');
const genreForm = $('#genreForm');

let editingBookId = null;
let editingShelfId = null;
let scanner = null;
let shelvesCache = [];
let genreTags = null;      // multi-select genres field (id-based)

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const ADD_BY_TAB = {
  books: { label: '+ Add book', fn: () => openAddBook() },
  shelves: { label: '+ Add shelf', fn: () => openAddShelf() },
  genres: { label: '+ Add genre', fn: () => openAddGenre() },
};
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const which = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#tab-books').hidden = which !== 'books';
    $('#tab-shelves').hidden = which !== 'shelves';
    $('#tab-genres').hidden = which !== 'genres';
    $('#addBtn').textContent = ADD_BY_TAB[which].label;
    $('#addBtn').onclick = ADD_BY_TAB[which].fn;
  });
});

// ---------------------------------------------------------------------------
// Books listing
// ---------------------------------------------------------------------------
// Search box + filter selects, mapped to their query params.
const FILTER_CONTROLS = [
  ['#search', 'q'], ['#filterStatus', 'status'], ['#filterFormat', 'format'],
  ['#filterGenre', 'genre_id'], ['#filterRoom', 'room'], ['#filterBookcase', 'bookcase'],
  ['#filterShelf', 'shelf_id'],
];

async function loadBooks() {
  const params = new URLSearchParams();
  let anyActive = false;
  for (const [sel, param] of FILTER_CONTROLS) {
    const v = $(sel).value;
    if (v) { params.set(param, v); anyActive = true; }
  }
  $('#clearFiltersBtn').hidden = !anyActive;

  const books = await api('/books?' + params.toString());
  const list = $('#list');
  list.innerHTML = '';
  $('#empty').hidden = books.length > 0;
  for (const b of books) list.appendChild(renderBookCard(b));
}

function clearFilters() {
  for (const [sel] of FILTER_CONTROLS) $(sel).value = '';
  loadBooks();
}

function renderBookCard(b) {
  const card = document.createElement('article');
  card.className = 'card';
  card.onclick = () => openEditBook(b);

  const location = [b.room, b.bookcase, b.shelf_label].filter(Boolean).join(' › ');
  const dims = b.height_mm && b.thickness_mm
    ? `${dispDim(b.height_mm)}×${dispDim(b.width_mm)}×${dispDim(b.thickness_mm)} ${UNIT}` : '';
  const cover = b.cover_url
    ? `<img class="cover" src="${esc(b.cover_url)}" alt="" loading="lazy" onerror="this.replaceWith(placeholderCover())" />`
    : placeholderCover().outerHTML;

  card.innerHTML = `
    ${cover}
    <div class="card-body">
      <h3>${esc(b.title)}</h3>
      <p class="authors">${esc(b.authors || 'Unknown author')}</p>
      <div class="badges">
        <span class="badge status-${b.status}">${STATUS_LABELS[b.status] || b.status}</span>
        ${b.is_library_book ? '<span class="badge library">Library</span>' : ''}
        ${b.format ? `<span class="badge muted">${FORMAT_LABELS[b.format] || b.format}</span>` : ''}
        ${b.jacket === 'missing' ? '<span class="badge muted">No jacket</span>' : ''}
      </div>
      ${b.genres && b.genres.length ? `<p class="loc">🏷 ${esc(b.genres.map((g) => g.name).join(', '))}</p>` : ''}
      ${location ? `<p class="loc">📍 ${esc(location)}</p>` : '<p class="loc muted-text">Unshelved</p>'}
      ${dims ? `<p class="loc">📐 ${dims}</p>` : ''}
      ${b.status === 'loaned' && b.loaned_to ? `<p class="loc">👤 ${esc(b.loaned_to)}</p>` : ''}
      ${b.is_library_book && b.due_date ? `<p class="loc due">⏰ Due ${esc(b.due_date)}</p>` : ''}
      ${b.source ? `<p class="loc muted-text">via ${esc(SOURCE_LABELS[b.source] || b.source)}</p>` : ''}
    </div>`;
  return card;
}

function placeholderCover() {
  const div = document.createElement('div');
  div.className = 'cover placeholder';
  div.textContent = '📖';
  return div;
}

// ---------------------------------------------------------------------------
// Shelves listing (with capacity)
// ---------------------------------------------------------------------------
async function loadShelves() {
  shelvesCache = await api('/shelves');
  const list = $('#shelfList');
  list.innerHTML = '';
  $('#shelfEmpty').hidden = shelvesCache.length > 0;
  for (const s of shelvesCache) list.appendChild(renderShelfCard(s));
  populateShelfSelect();
  populateShelfFilter();
}

function renderShelfCard(s) {
  const card = document.createElement('article');
  card.className = 'card shelf-card';

  const heading = [s.room, s.bookcase].filter(Boolean).join(' › ');
  const pct = s.fill_pct;
  const barClass = s.overfull ? 'bar over' : pct != null && pct > 90 ? 'bar warn' : 'bar';
  const capacity = s.width_mm == null
    ? '<p class="hint">Set a width to track capacity.</p>'
    : `<div class="${barClass}"><span style="width:${Math.min(pct ?? 0, 100)}%"></span></div>
       <p class="cap-line">
         ${s.book_count} book${s.book_count === 1 ? '' : 's'} ·
         ${dispDim(s.used_width_mm)} / ${dispDim(s.width_mm)} ${UNIT} ${pct != null ? `(${pct}%)` : ''}
       </p>
       <p class="cap-line ${s.overfull ? 'due' : ''}">
         ${s.overfull
           ? `Over capacity by ${dispDim(-s.free_width_mm)} ${UNIT}`
           : `~${s.est_additional} more fit · ${dispDim(s.free_width_mm)} ${UNIT} free`}
       </p>`;

  const flags = [];
  if (s.too_tall) flags.push(`⚠️ ${s.too_tall} too tall`);
  if (s.too_deep) flags.push(`⚠️ ${s.too_deep} too deep`);
  if (s.width_mm && s.unknown_thickness) flags.push(`${s.unknown_thickness} missing thickness`);

  card.innerHTML = `
    <div class="card-body grow">
      <h3>${esc(s.label)}</h3>
      ${heading ? `<p class="authors">${esc(heading)}</p>` : ''}
      <p class="loc">📐 ${s.width_mm ? dispDim(s.width_mm) + ' W' : '—'} × ${s.height_mm ? dispDim(s.height_mm) + ' H' : '—'} × ${s.depth_mm ? dispDim(s.depth_mm) + ' D' : '—'} ${UNIT}</p>
      ${capacity}
      ${flags.length ? `<div class="badges">${flags.map((f) => `<span class="badge muted">${f}</span>`).join('')}</div>` : ''}
      <div class="shelf-actions">
        <button type="button" class="link" data-view="${s.id}">View books</button>
        <button type="button" class="link" data-copy="${s.id}">Copy</button>
        <button type="button" class="link" data-edit="${s.id}">Edit</button>
      </div>
    </div>`;

  card.querySelector('[data-view]').onclick = () => viewShelfBooks(s.id);
  card.querySelector('[data-copy]').onclick = () => openCopyShelf(s);
  card.querySelector('[data-edit]').onclick = () => openEditShelf(s);
  return card;
}

function viewShelfBooks(shelfId) {
  document.querySelector('.tab[data-tab="books"]').click();
  $('#filterShelf').value = String(shelfId);
  loadBooks();
}

// ---------------------------------------------------------------------------
// Book dialog
// ---------------------------------------------------------------------------
function openAddBook() {
  editingBookId = null;
  bookForm.reset();
  $('#dialogTitle').textContent = 'Add book';
  $('#deleteBtn').hidden = true;
  $('#coverPreview').hidden = true;
  $('#lookupMsg').hidden = true;
  $('#fitWarning').hidden = true;
  $('#suggestResult').hidden = true;
  $('#dupWarning').hidden = true;
  genreTags.set([]);
  setScanUI('📷 Scan', null);
  syncBookFields();
  bookDialog.showModal();
  $('#isbn').focus();
}


function openEditBook(book) {
  editingBookId = book.id;
  bookForm.reset();
  $('#dialogTitle').textContent = 'Edit book';
  $('#deleteBtn').hidden = false;
  for (const [key, value] of Object.entries(book)) {
    const field = bookForm.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = !!value;
    else field.value = value ?? '';
  }
  genreTags.set(book.genre_ids || []);
  DIM_FIELDS.forEach((f) => { if (bookForm.elements[f]) bookForm.elements[f].value = mmToUnit(book[f]); });
  showCover(book.cover_url);
  $('#lookupMsg').hidden = true;
  $('#suggestResult').hidden = true;
  $('#dupWarning').hidden = true;
  setScanUI('📷 Scan', null);
  syncBookFields();
  bookDialog.showModal();
}

function showCover(url) {
  const img = $('#coverPreview');
  if (url) { img.src = url; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
}

// ---------------------------------------------------------------------------
// Cover photo: pick from camera or file (the file input offers both on phones),
// then crop/resize with Cropper.js. Result is stored as a downscaled data URL.
// ---------------------------------------------------------------------------
const cropDialog = $('#cropDialog');
let cropper = null;
let cropObjectUrl = null;

function onCoverFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // let the same file be re-picked later
  if (!file) return;
  if (cropObjectUrl) URL.revokeObjectURL(cropObjectUrl);
  cropObjectUrl = URL.createObjectURL(file);
  const img = $('#cropImage');
  img.src = cropObjectUrl;
  cropDialog.showModal();
  if (cropper) cropper.destroy();
  cropper = new Cropper(img, { viewMode: 1, autoCropArea: 1, background: false, dragMode: 'move' });
}

function useCroppedCover() {
  if (cropper) {
    const canvas = cropper.getCroppedCanvas({ maxWidth: 800, maxHeight: 1200, imageSmoothingQuality: 'high' });
    if (canvas) {
      const url = canvas.toDataURL('image/jpeg', 0.85);
      bookForm.elements.cover_url.value = url;
      showCover(url);
    }
  }
  closeCropDialog();
}

function closeCropDialog() {
  if (cropper) { cropper.destroy(); cropper = null; }
  if (cropObjectUrl) { URL.revokeObjectURL(cropObjectUrl); cropObjectUrl = null; }
  cropDialog.close();
}

function syncBookFields() {
  $('#loanedField').hidden = $('#statusSelect').value !== 'loaned';
  $('#libraryFields').hidden = !$('#isLibraryBook').checked;
  checkFit();
}

// Warn if the chosen shelf can't physically hold this book.
function checkFit() {
  const warn = $('#fitWarning');
  const shelfId = Number(bookForm.elements.shelf_id.value);
  const shelf = shelvesCache.find((s) => s.id === shelfId);
  if (!shelf) { warn.hidden = true; return; }

  const h = Number(unitToMm(bookForm.elements.height_mm.value)) || 0;
  const w = Number(unitToMm(bookForm.elements.width_mm.value)) || 0;
  const t = Number(unitToMm(bookForm.elements.thickness_mm.value)) || 0;
  const issues = [];
  if (shelf.height_mm && h && h > shelf.height_mm) issues.push(`too tall (${dispDim(h)} > ${dispDim(shelf.height_mm)} ${UNIT})`);
  if (shelf.depth_mm && w && w > shelf.depth_mm) issues.push(`too deep (${dispDim(w)} > ${dispDim(shelf.depth_mm)} ${UNIT})`);
  // Remaining width, giving this book back its own spine if already on the shelf.
  if (shelf.width_mm && t) {
    let free = shelf.free_width_mm ?? (shelf.width_mm - shelf.used_width_mm);
    if (editingBookId && shelf.id === Number(bookForm.elements.shelf_id.value)) free += t;
    if (t > free) issues.push(`only ${dispDim(free)} ${UNIT} free, spine is ${dispDim(t)} ${UNIT}`);
  }
  warn.hidden = issues.length === 0;
  warn.textContent = issues.length ? '⚠️ On this shelf: ' + issues.join('; ') : '';
}

// Books already in the library with the same ISBN (excluding the one being edited).
async function findByIsbn(isbn) {
  const norm = String(isbn || '').replace(/[^0-9Xx]/g, '');
  if (!norm) return [];
  const books = await api('/books?q=' + encodeURIComponent(norm));
  return books.filter((b) => (b.isbn || '').replace(/[^0-9Xx]/g, '') === norm && b.id !== editingBookId);
}

// Non-blocking heads-up in the dialog when the scanned/entered ISBN is a dup.
async function checkDuplicate() {
  const el = $('#dupWarning');
  const dups = await findByIsbn($('#isbn').value).catch(() => []);
  if (dups.length) {
    el.hidden = false;
    el.textContent = `⚠️ Already in your library: ${dups.map((b) => b.title).join(', ')}. Saving adds another copy.`;
  } else {
    el.hidden = true;
  }
}

// Prompt for a duplicate ISBN: one option per existing copy (shown by format +
// location, resolves to editing that record), plus a "new" option, plus cancel.
// Resolves to { type: 'edit', book } | { type: 'new' } | { type: 'cancel' }.
function askDuplicate(dups, newData) {
  return new Promise((resolve) => {
    const dlg = $('#dupDialog');
    const cancelBtn = $('#dupCancelBtn');
    $('#dupDialogMsg').textContent =
      `This ISBN is already in your library (${dups.length} record${dups.length === 1 ? '' : 's'}). `
      + 'Edit an existing copy, add it as a new one, or cancel.';

    const cleanup = () => { cancelBtn.removeEventListener('click', onCancel); dlg.removeEventListener('cancel', onEsc); };
    const finish = (result) => { cleanup(); dlg.close(); resolve(result); };
    const onCancel = () => finish({ type: 'cancel' });
    const onEsc = (e) => { e.preventDefault(); finish({ type: 'cancel' }); };
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onEsc);

    const opts = $('#dupOptions');
    opts.innerHTML = '';
    for (const b of dups) {
      const loc = [b.room, b.bookcase, b.shelf_label].filter(Boolean).join(' › ') || 'Unshelved';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dup-option';
      btn.innerHTML = `<strong>${esc(b.title)}</strong><span>${esc(`${FORMAT_LABELS[b.format] || b.format || 'Book'} · ${loc}`)}</span>`;
      btn.addEventListener('click', () => finish({ type: 'edit', book: b }));
      opts.appendChild(btn);
    }
    const nb = document.createElement('button');
    nb.type = 'button';
    nb.className = 'dup-option new';
    nb.innerHTML = `<strong>${esc(newData.title || 'This book')}</strong><span>new</span>`;
    nb.addEventListener('click', () => finish({ type: 'new' }));
    opts.appendChild(nb);

    dlg.showModal();
  });
}

async function saveBook(e) {
  e.preventDefault();
  // Commit any leftover text in the genres field (prompting to define a new
  // one). Bail if the user cancels a definition prompt.
  if (!await genreTags.commitPending()) return;

  const data = Object.fromEntries(new FormData(bookForm).entries());
  data.is_library_book = $('#isLibraryBook').checked;
  data.genre_ids = genreTags.get();
  DIM_FIELDS.forEach((f) => { if (f in data) data[f] = unitToMm(data[f]); });

  // On a duplicate ISBN (adding only), let the user edit an existing copy,
  // add a new one, or cancel.
  let openAfterCreate = false;
  if (!editingBookId) {
    const dups = await findByIsbn(data.isbn).catch(() => []);
    if (dups.length) {
      const choice = await askDuplicate(dups, data);
      if (choice.type === 'cancel') return;
      if (choice.type === 'edit') { closeBookDialog(); openEditBook(choice.book); return; }
      openAfterCreate = true; // 'new' — create it, then open it for editing
    }
  }

  try {
    let saved;
    if (editingBookId) saved = await api('/books/' + editingBookId, { method: 'PUT', headers: json(), body: JSON.stringify(data) });
    else saved = await api('/books', { method: 'POST', headers: json(), body: JSON.stringify(data) });
    closeBookDialog();
    await refresh();
    if (openAfterCreate && saved) openEditBook(saved);
  } catch (err) { alert('Save failed: ' + err.message); }
}

async function deleteBook() {
  if (!editingBookId || !confirm('Delete this book?')) return;
  await api('/books/' + editingBookId, { method: 'DELETE' });
  closeBookDialog();
  await refresh();
}

function closeBookDialog() { stopScanner(); bookDialog.close(); }

// ---------------------------------------------------------------------------
// Shelf dialog
// ---------------------------------------------------------------------------
function openAddShelf() {
  editingShelfId = null;
  shelfForm.reset();
  $('#shelfDialogTitle').textContent = 'Add shelf';
  $('#deleteShelfBtn').hidden = true;
  shelfDialog.showModal();
}

function openEditShelf(shelf) {
  editingShelfId = shelf.id;
  shelfForm.reset();
  $('#shelfDialogTitle').textContent = 'Edit shelf';
  $('#deleteShelfBtn').hidden = false;
  for (const [key, value] of Object.entries(shelf)) {
    const field = shelfForm.elements[key];
    if (field) field.value = value ?? '';
  }
  DIM_FIELDS.forEach((f) => { if (shelfForm.elements[f]) shelfForm.elements[f].value = mmToUnit(shelf[f]); });
  shelfDialog.showModal();
}

// Duplicate a shelf's room/bookcase/dimensions/notes as a NEW shelf (books are
// not copied) — handy for the many like-sized shelves in one bookcase.
function openCopyShelf(shelf) {
  editingShelfId = null;                 // null => save creates a new shelf
  shelfForm.reset();
  $('#shelfDialogTitle').textContent = 'Copy shelf';
  $('#deleteShelfBtn').hidden = true;
  for (const key of ['room', 'bookcase', 'notes']) {
    if (shelfForm.elements[key]) shelfForm.elements[key].value = shelf[key] ?? '';
  }
  DIM_FIELDS.forEach((f) => { if (shelfForm.elements[f]) shelfForm.elements[f].value = mmToUnit(shelf[f]); });
  shelfForm.elements.label.value = suggestCopyLabel(shelf);
  shelfDialog.showModal();
  shelfForm.elements.label.select();     // pre-select the name for quick editing
}

// Suggest a fresh, non-colliding label: bump a trailing number ("Shelf 1" ->
// "Shelf 2"), otherwise append "copy". Only considers shelves in the same
// room + bookcase so numbering restarts per bookcase.
function suggestCopyLabel(shelf) {
  const sameCase = (a, b) => (a || '') === (b || '');
  const taken = new Set(shelvesCache
    .filter((s) => sameCase(s.room, shelf.room) && sameCase(s.bookcase, shelf.bookcase))
    .map((s) => s.label));

  const m = String(shelf.label).match(/^(.*?)(\d+)(\D*)$/);
  if (m) {
    const [, prefix, num, suffix] = m;
    let n = parseInt(num, 10) + 1;
    let candidate = `${prefix}${n}${suffix}`;
    while (taken.has(candidate)) candidate = `${prefix}${++n}${suffix}`;
    return candidate;
  }
  let candidate = `${shelf.label} copy`;
  for (let i = 2; taken.has(candidate); i++) candidate = `${shelf.label} copy ${i}`;
  return candidate;
}

async function saveShelf(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(shelfForm).entries());
  DIM_FIELDS.forEach((f) => { if (f in data) data[f] = unitToMm(data[f]); });
  try {
    if (editingShelfId) await api('/shelves/' + editingShelfId, { method: 'PUT', headers: json(), body: JSON.stringify(data) });
    else await api('/shelves', { method: 'POST', headers: json(), body: JSON.stringify(data) });
    shelfDialog.close();
    await refresh();
  } catch (err) { alert('Save failed: ' + err.message); }
}

async function deleteShelf() {
  if (!editingShelfId || !confirm('Delete this shelf? Books on it become unshelved.')) return;
  await api('/shelves/' + editingShelfId, { method: 'DELETE' });
  shelfDialog.close();
  await refresh();
}

// ---------------------------------------------------------------------------
// Shelf selects
// ---------------------------------------------------------------------------
// Full "Room › Bookcase › Shelf" location for a shelf.
const fullShelfPath = (s) => [s.room, s.bookcase, s.label].filter(Boolean).join(' › ');
const shelvesByPath = () => [...shelvesCache].sort((a, b) => fullShelfPath(a).localeCompare(fullShelfPath(b)));

function populateShelfSelect() {
  const sel = $('#shelfSelect');
  const current = sel.value;
  sel.innerHTML = '<option value="">— Unshelved —</option>'
    + shelvesByPath().map((s) => `<option value="${s.id}">${esc(fullShelfPath(s))}</option>`).join('');
  sel.value = current;
}

function populateShelfFilter() {
  const sel = $('#filterShelf');
  const current = sel.value;
  sel.innerHTML = '<option value="">All shelves</option><option value="none">Unshelved</option>'
    + shelvesByPath().map((s) => `<option value="${s.id}">${esc(fullShelfPath(s))}</option>`).join('');
  sel.value = current;
}

// ---------------------------------------------------------------------------
// ISBN lookup + scanning
// ---------------------------------------------------------------------------
async function lookup() {
  const isbn = $('#isbn').value.trim();
  if (!isbn) return;
  checkDuplicate();   // heads-up if this ISBN is already in the library
  const msg = $('#lookupMsg');
  msg.hidden = false; msg.className = 'msg'; msg.textContent = 'Looking up…';
  try {
    const d = await api('/lookup/' + encodeURIComponent(isbn));
    setIfEmpty('title', d.title);
    setIfEmpty('authors', d.authors);
    setIfEmpty('publisher', d.publisher);
    setIfEmpty('published_date', d.published_date);
    setIfEmpty('page_count', d.page_count);
    setDimIfEmpty('height_mm', d.height_mm);
    setDimIfEmpty('width_mm', d.width_mm);
    setDimIfEmpty('thickness_mm', d.thickness_mm);
    if (d.cover_url) { bookForm.elements.cover_url.value = d.cover_url; showCover(d.cover_url); }
    if (d.source && bookForm.elements.source) bookForm.elements.source.value = d.source;
    const gotDims = d.height_mm || d.thickness_mm;
    msg.textContent = `Found via ${SOURCE_LABELS[d.source] || d.source}.` + (gotDims ? ' Dimensions included.' : ' No dimensions available — measure manually for shelf fit.');
    msg.classList.add(gotDims ? 'ok' : 'warn');
    checkFit();
  } catch (err) { msg.textContent = err.message; msg.classList.add('err'); }
}

function setIfEmpty(name, value) {
  const f = bookForm.elements[name];
  if (f && value != null && value !== '' && !f.value) f.value = value;
}

// Auto-fill a dimension field (API gives mm) using the active display unit.
function setDimIfEmpty(name, mm) {
  const f = bookForm.elements[name];
  if (f && mm != null && mm !== '' && !f.value) f.value = mmToUnit(mm);
}

// State machine so clicks during camera start-up/tear-down are ignored rather
// than orphaning the stream (which used to break every scan after the first).
let scanState = 'idle'; // idle | starting | running | stopping
let pendingStop = false;
// Devices WITHOUT the native BarcodeDetector (all iOS/WebKit browsers) use the
// Quagga2 1D decoder; devices WITH it (Android Chrome) keep the fast native path
// via html5-qrcode — so Android's instant scan isn't regressed.
const NATIVE_DETECTOR = typeof window !== 'undefined' && 'BarcodeDetector' in window;
let lastCode = null;
let lastCount = 0;

function setScanUI(label, status) {
  $('#scanBtn').textContent = label;
  const s = $('#scanStatus');
  if (status) { s.hidden = false; s.textContent = status; } else { s.hidden = true; }
}

function onScanButton() {
  if (scanState === 'idle') startScanner();
  else if (scanState === 'running') stopScanner();
  // starting / stopping: ignore extra clicks
}

async function startScanner() {
  if (scanState !== 'idle') return;
  scanState = 'starting';
  pendingStop = false;
  lastCode = null;
  lastCount = 0;
  $('#scanner').hidden = false;
  setScanUI('…', 'Requesting camera — allow access if prompted.');
  try {
    if (NATIVE_DETECTOR) await startNativeScanner();
    else await startQuaggaScanner();
    scanState = 'running';
    setScanUI('■ Stop', 'Fill the box with the barcode · hold steady · good light.');
    if (pendingStop) stopScanner();   // dialog was closed while the camera was starting
  } catch (err) {
    await teardownScanner();
    setScanUI('📷 Scan', null);
    alert(scannerErrorHelp(err));
  }
}

// Fast path: native BarcodeDetector via html5-qrcode (Android Chrome).
async function startNativeScanner() {
  scanner = new Html5Qrcode('scanner', {
    verbose: false,
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
    ],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });
  // html5-qrcode requires cameraIdOrConfig to be a single-key object (a deviceId
  // or facingMode) — resolution/focus hints must go in videoConstraints, not here.
  await scanner.start(
    { facingMode: 'environment' },
    {
      fps: 15,
      qrbox: (vw, vh) => ({ width: Math.round(Math.min(vw * 0.9, 480)), height: Math.round(Math.min(vh * 0.5, 220)) }),
      videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    },
    (text) => acceptScan(text),
    () => {},
  );
}

// Fallback path: Quagga2 1D decoder for iOS/WebKit (no native BarcodeDetector).
async function startQuaggaScanner() {
  const box = $('#scanner');
  box.innerHTML = '';
  await new Promise((resolve, reject) => {
    Quagga.init({
      inputStream: {
        type: 'LiveStream',
        target: box,
        constraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      },
      locator: { patchSize: 'medium', halfSample: true },
      numOfWorkers: 0,   // no web workers -> avoids worker-URL issues, robust everywhere
      frequency: 10,
      decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'] },
      locate: true,
    }, (err) => (err ? reject(err) : resolve()));
  });
  Quagga.onDetected(onQuaggaDetected);
  Quagga.start();
}

// Quagga can misread; require the same, checksum-valid code twice before trusting it.
function onQuaggaDetected(result) {
  if (scanState !== 'running') return;
  const code = result && result.codeResult && result.codeResult.code;
  if (!code || !isValidEan(code)) return;
  if (code === lastCode) lastCount += 1;
  else { lastCode = code; lastCount = 1; }
  if (lastCount >= 2) acceptScan(code);
}

// Validate an EAN-13 / EAN-8 / UPC-A check digit to reject misreads.
function isValidEan(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += digits[i] * weight;
  }
  return (10 - (sum % 10)) % 10 === check;
}

function acceptScan(text) {
  if (scanState !== 'running') return;   // ignore late/duplicate detections
  $('#isbn').value = String(text).replace(/[^0-9Xx]/g, '');
  stopScanner().then(lookup);
}

// Turn a getUserMedia failure into advice that actually matches the situation
// (the raw NotAllowedError, and iOS's Safari-only camera quirk, are confusing).
function scannerErrorHelp(err) {
  const ua = navigator.userAgent || '';
  const iOS = /iP(ad|hone|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const iOSNonSafari = iOS && /(CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo)/i.test(ua);
  // html5-qrcode wraps the DOMException, so the original type only survives in
  // the message text — match against both name and message.
  const hay = `${(err && err.name) || ''} ${(err && err.message) || ''}`;
  const denied = /NotAllowedError|SecurityError|PermissionDenied/i.test(hay);
  const notFound = /NotFoundError|OverconstrainedError|DevicesNotFound/i.test(hay);

  if (!window.isSecureContext) {
    return 'The camera needs a secure (HTTPS) connection. Open the app at ' +
      'https://homelab.dala-hue.ts.net/library/ and try again.';
  }
  if (denied) {
    if (iOSNonSafari) {
      return 'On iPhone/iPad, camera scanning works reliably only in Safari — Chrome and ' +
        'other browsers usually block it.\n\nOpen this page in Safari and tap “Allow”. ' +
        '(To keep using Chrome instead, first enable Settings → Chrome → Camera.)';
    }
    if (iOS) {
      return 'Camera access was blocked. On iPhone/iPad: tap “aA” in the address bar → ' +
        'Website Settings → Camera → Allow (or Settings → Safari → Camera → Ask), make sure ' +
        'Lockdown Mode is off, then reload and tap Allow.';
    }
    return 'Camera access was blocked. Allow camera permission for this site (address-bar / ' +
      'site settings), then tap Scan again.';
  }
  if (notFound) {
    return 'No usable camera was found on this device. You can type the ISBN in manually instead.';
  }
  return 'Could not start the camera: ' + (err && err.message ? err.message : err);
}

async function stopScanner() {
  if (scanState === 'starting') { pendingStop = true; return; } // stop once start() resolves
  if (scanState !== 'running') return;
  scanState = 'stopping';
  await teardownScanner();
  setScanUI('📷 Scan', null);
}

// Stop the stream and dispose the engine, tolerating any half-started state.
async function teardownScanner() {
  if (NATIVE_DETECTOR) {
    if (scanner) {
      try { await scanner.stop(); } catch { /* wasn't running */ }
      try { scanner.clear(); } catch { /* already cleared */ }
      scanner = null;
    }
  } else {
    try { Quagga.offDetected(onQuaggaDetected); } catch { /* not initialised */ }
    try { await Quagga.stop(); } catch { /* not running */ }
    $('#scanner').innerHTML = '';
  }
  $('#scanner').hidden = true;
  scanState = 'idle';
  pendingStop = false;
  lastCode = null;
  lastCount = 0;
}

// ---------------------------------------------------------------------------
// EPUB import
// ---------------------------------------------------------------------------
function openImportDialog() {
  const sel = $('#importShelf');
  const current = sel.value;
  sel.innerHTML = '<option value="">— none —</option>'
    + shelvesByPath().map((s) => `<option value="${s.id}">${esc(fullShelfPath(s))}</option>`).join('');
  sel.value = current;
  $('#importFiles').value = '';
  $('#importProgress').hidden = true;
  $('#importDialog').showModal();
}

async function runImport() {
  const files = [...$('#importFiles').files];
  if (!files.length) { alert('Choose one or more .epub files first.'); return; }
  const shelfId = $('#importShelf').value;
  const prog = $('#importProgress');
  const runBtn = $('#importRunBtn');
  runBtn.disabled = true;
  prog.hidden = false; prog.className = 'msg';
  let ok = 0;
  const failures = [];
  for (let i = 0; i < files.length; i += 1) {
    prog.textContent = `Importing ${i + 1} of ${files.length}… (${ok} added)`;
    try {
      const buf = await files[i].arrayBuffer();
      await api('/import/epub' + (shelfId ? `?shelf_id=${shelfId}` : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/epub+zip' }, body: buf,
      });
      ok += 1;
    } catch (err) { failures.push(`${files[i].name}: ${err.message}`); }
  }
  prog.className = `msg ${failures.length ? 'warn' : 'ok'}`;
  prog.textContent = `Imported ${ok} of ${files.length}.${failures.length ? ` ${failures.length} failed.` : ''}`;
  runBtn.disabled = false;
  await refresh();
}

// ---------------------------------------------------------------------------
// Metadata + refresh
// ---------------------------------------------------------------------------
// Distinct values powering the custom autocomplete dropdowns; refreshed by loadMeta.
const META = { rooms: [], bookcases: [] };

async function loadMeta() {
  const meta = await api('/meta');
  $('#count').textContent = `${meta.count} book${meta.count === 1 ? '' : 's'}` +
    (meta.unshelved ? ` · ${meta.unshelved} unshelved` : '');
  Object.assign(META, { rooms: meta.rooms, bookcases: meta.bookcases });
  fillSelect('filterRoom', meta.rooms, 'All rooms');
  fillSelect('filterBookcase', meta.bookcases, 'All bookcases');
  populateGenreFilter();
}

// Genre filter is id-based: one option per taxonomy entry (subgenres qualified
// "Parent › Child"), so filtering matches book_genres exactly.
function populateGenreFilter() {
  const sel = $('#filterGenre');
  const current = sel.value;
  const opts = [...genresCache]
    .map((g) => ({ id: g.id, label: genreLabel(g) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  sel.innerHTML = '<option value="">All genres</option>'
    + opts.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('');
  sel.value = current;
}

function fillSelect(id, values, allLabel) {
  const sel = document.getElementById(id);
  const current = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
  sel.value = current;
}

// Lightweight autocomplete to replace <datalist>, whose native popup covered the
// keyboard on Android with no way to dismiss it. This dropdown sits in the dialog
// below the field, is dismissible (tap away / Esc), and never blocks free typing.
function attachCombo(input, getItems) {
  const label = input.closest('label');
  label.classList.add('combo');
  const list = document.createElement('ul');
  list.className = 'combo-list';
  list.hidden = true;
  label.appendChild(list);
  let active = -1;

  const close = () => { list.hidden = true; list.innerHTML = ''; active = -1; };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const items = getItems()
      .filter((v) => v.toLowerCase().includes(q) && v.toLowerCase() !== q)
      .slice(0, 6);
    if (!items.length) return close();
    list.innerHTML = items.map((v) => `<li role="option">${esc(v)}</li>`).join('');
    list.hidden = false;
    active = -1;
  };
  const choose = (li) => { input.value = li.textContent; close(); input.focus(); };

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(close, 150));
  // pointerdown fires before blur and preventDefault keeps the field focused.
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); choose(li); }
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const items = [...list.children];
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); return; }
    else if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    else return;
    items.forEach((li, i) => li.classList.toggle('active', i === active));
  });
}

// ---------------------------------------------------------------------------
// Genres (hierarchical taxonomy + definitions)
// ---------------------------------------------------------------------------
let genresCache = [];
let editingGenreId = null;

const topGenres = () => genresCache.filter((g) => !g.parent_id);
const subGenres = (parentId) => genresCache.filter((g) => g.parent_id === parentId);

async function loadGenres() {
  genresCache = await api('/genres');
  renderGenres();
  populateGenreFilter();
}

function renderGenres() {
  const list = $('#genreList');
  list.innerHTML = '';
  for (const g of topGenres().sort((a, b) => a.name.localeCompare(b.name))) {
    list.appendChild(renderGenreRow(g, 0));
    for (const c of subGenres(g.id).sort((a, b) => a.name.localeCompare(b.name))) {
      list.appendChild(renderGenreRow(c, 1));
    }
  }
}

function renderGenreRow(g, depth) {
  const row = document.createElement('div');
  row.className = `genre-row${depth ? ' sub' : ''}`;
  row.innerHTML = `
    <div class="genre-main">
      <span class="genre-name">${esc(g.name)}</span>
      <span class="genre-def">${esc(g.definition || 'No definition yet.')}</span>
    </div>
    <button type="button" class="link" data-edit-genre="${g.id}">Edit</button>`;
  row.querySelector('[data-edit-genre]').onclick = () => openEditGenre(g);
  return row;
}

function fillGenreParentSelect(excludeId) {
  const sel = $('#genreParent');
  const current = sel.value;
  sel.innerHTML = '<option value="">— top-level genre —</option>'
    + topGenres().filter((g) => g.id !== excludeId).sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  sel.value = current;
}

function openAddGenre() {
  editingGenreId = null;
  genreForm.reset();
  $('#genreDialogTitle').textContent = 'Add genre';
  $('#deleteGenreBtn').hidden = true;
  fillGenreParentSelect(null);
  $('#genreParent').disabled = false;
  genreDialog.showModal();
}

function openEditGenre(g) {
  editingGenreId = g.id;
  genreForm.reset();
  $('#genreDialogTitle').textContent = 'Edit genre';
  $('#deleteGenreBtn').hidden = false;
  fillGenreParentSelect(g.id);
  genreForm.elements.name.value = g.name;
  genreForm.elements.definition.value = g.definition || '';
  genreForm.elements.parent_id.value = g.parent_id || '';
  // Reparenting isn't supported here (would change hierarchy meaning); lock it.
  $('#genreParent').disabled = true;
  genreDialog.showModal();
}

async function saveGenre(e) {
  e.preventDefault();
  const data = {
    name: genreForm.elements.name.value.trim(),
    definition: genreForm.elements.definition.value,
    parent_id: genreForm.elements.parent_id.value || null,
  };
  if (!data.name) return;
  try {
    if (editingGenreId) await api('/genres/' + editingGenreId, { method: 'PUT', headers: json(), body: JSON.stringify(data) });
    else await api('/genres', { method: 'POST', headers: json(), body: JSON.stringify(data) });
    genreDialog.close();
    await loadGenres();
  } catch (err) { alert('Save failed: ' + err.message); }
}

async function deleteGenre() {
  if (!editingGenreId) return;
  const g = genresCache.find((x) => x.id === editingGenreId);
  const kids = g && !g.parent_id ? subGenres(g.id).length : 0;
  const warn = kids ? `\n\nIts ${kids} subgenre(s) will also be deleted.` : '';
  if (!confirm(`Delete the genre “${g ? g.name : ''}”?${warn}\n\nBooks keep their genre text.`)) return;
  await api('/genres/' + editingGenreId, { method: 'DELETE' });
  genreDialog.close();
  await loadGenres();
}

// Prompt for a definition (and parent) when a brand-new genre is typed in the
// book form. `candidates` are the top-level genres offered as a possible parent
// (or leave top-level). Creates it (POST /api/genres) and resolves to the record
// (or null if cancelled).
function promptNewGenre(name, candidates) {
  return new Promise((resolve) => {
    const dlg = $('#newGenreDialog');
    const list = Array.isArray(candidates) ? candidates : [];
    $('#newGenreTitle').textContent = 'New genre';
    $('#newGenrePrompt').textContent = `“${name}” is new. Pick a parent (or leave it top-level) and add a definition:`;
    const parentSel = $('#newGenreParent');
    $('#newGenreParentRow').hidden = false;
    parentSel.innerHTML = '<option value="">— top-level genre —</option>'
      + list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('#newGenreDefinition').value = '';
    const saveBtn = $('#newGenreSave');
    const cancelBtn = $('#newGenreCancel');
    const cleanup = () => { saveBtn.removeEventListener('click', onSave); cancelBtn.removeEventListener('click', onCancel); dlg.removeEventListener('cancel', onEsc); };
    const onSave = async () => {
      try {
        const g = await api('/genres', {
          method: 'POST', headers: json(),
          body: JSON.stringify({ name, definition: $('#newGenreDefinition').value, parent_id: parentSel.value ? Number(parentSel.value) : null }),
        });
        if (!genresCache.some((x) => x.id === g.id)) genresCache.push(g);
        cleanup(); dlg.close(); resolve(g);
      } catch (err) { alert('Could not add genre: ' + err.message); }
    };
    const onCancel = () => { cleanup(); dlg.close(); resolve(null); };
    const onEsc = (ev) => { ev.preventDefault(); onCancel(); };
    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onEsc);
    dlg.showModal();
    $('#newGenreDefinition').focus();
  });
}

// ---------------------------------------------------------------------------
// Genre multi-select (id-based). Chips hold genre ids; the book stores its
// genres via the book_genres join table (data.genre_ids). Suggestions cover the
// whole taxonomy, subgenres shown as "Parent › Child" to disambiguate.
// ---------------------------------------------------------------------------
const genreById = (id) => genresCache.find((g) => g.id === id);
function genreLabel(g) {
  if (!g) return '';
  if (!g.parent_id) return g.name;
  const p = genreById(g.parent_id);
  return p ? `${p.name} › ${g.name}` : g.name;
}

function createGenreField(input) {
  const field = input.closest('.tag-field');
  const label = field.closest('label');
  label.classList.add('combo'); // position: relative, so the dropdown anchors here
  let ids = [];
  const list = document.createElement('ul');
  list.className = 'combo-list';
  list.hidden = true;
  label.appendChild(list);
  let active = -1;
  let busy = false;

  const renderChips = () => {
    field.querySelectorAll('.chip').forEach((c) => c.remove());
    ids.forEach((id, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${esc(genreLabel(genreById(id)))} <button type="button" aria-label="Remove">✕</button>`;
      chip.querySelector('button').onclick = () => { ids.splice(i, 1); renderChips(); };
      field.insertBefore(chip, input);
    });
  };
  const closeList = () => { list.hidden = true; list.innerHTML = ''; active = -1; };
  const suggestions = () => {
    const q = input.value.trim().toLowerCase();
    return genresCache
      .filter((g) => !ids.includes(g.id))
      .map((g) => ({ id: g.id, label: genreLabel(g), name: g.name }))
      .filter((o) => o.label.toLowerCase().includes(q) || o.name.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 8);
  };
  const renderList = () => {
    const items = suggestions();
    if (!items.length) return closeList();
    list.innerHTML = items.map((o) => `<li role="option" data-id="${o.id}">${esc(o.label)}</li>`).join('');
    list.hidden = false; active = -1;
  };
  const addId = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
    input.value = ''; renderChips(); closeList();
  };
  // Resolve typed text to a genre id, creating a new genre if none match.
  // Returns an id, 'ambiguous', or null (cancelled / no match created).
  const resolve = async (raw) => {
    const text = (raw || '').replace(/[,;]+$/, '').trim();
    if (!text) return null;
    const lc = text.toLowerCase();
    const matches = genresCache.filter((g) => g.name.toLowerCase() === lc || genreLabel(g).toLowerCase() === lc);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) return 'ambiguous';
    const created = await promptNewGenre(text, topGenres().map((g) => ({ id: g.id, name: g.name })));
    return created ? created.id : null;
  };
  const commit = async (raw) => {
    if (busy) return;
    busy = true;
    try {
      const r = await resolve(raw);
      if (r === 'ambiguous') { renderList(); return; } // keep list open; user picks the specific one
      if (r) addId(r);
    } finally { busy = false; }
  };

  // Commit on a typed delimiter via the input event too. Mobile virtual
  // keyboards often don't fire keydown with e.key === ',' (they report keyCode
  // 229 / 'Unidentified'), so relying on keydown alone drops commits on phones.
  input.addEventListener('input', async () => {
    if (/[,;]/.test(input.value)) {
      const parts = input.value.split(/[,;]/);
      const tail = parts.pop();
      input.value = '';
      for (const part of parts) { if (part.trim()) await commit(part); }
      input.value = tail;
    }
    renderList();
  });
  input.addEventListener('focus', renderList);
  input.addEventListener('blur', () => setTimeout(closeList, 150));
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); addId(Number(li.dataset.id)); }
  });
  input.addEventListener('keydown', (e) => {
    if (!list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const lis = [...list.children];
      active = e.key === 'ArrowDown' ? Math.min(active + 1, lis.length - 1) : Math.max(active - 1, 0);
      lis.forEach((li, i) => li.classList.toggle('active', i === active));
      return;
    }
    if (e.key === 'Enter' && active >= 0 && !list.hidden) { e.preventDefault(); addId(Number(list.children[active].dataset.id)); return; }
    if (e.key === ',' || e.key === ';' || e.key === 'Enter' || e.key === 'Tab') {
      if (e.key === 'Tab' && !input.value.trim()) return;
      e.preventDefault();
      commit(input.value);
    } else if (e.key === 'Backspace' && !input.value && ids.length) {
      ids.pop(); renderChips();
    }
  });

  return {
    get: () => ids.slice(),
    set: (arr) => { ids = (arr || []).map(Number).filter((n) => genreById(n)); renderChips(); input.value = ''; },
    commitPending: async () => {
      const text = input.value.trim();
      if (!text) return true;
      const r = await resolve(text);
      if (r === 'ambiguous') { alert(`"${text}" matches more than one genre — pick the specific one from the list.`); return false; }
      if (!r) return false;
      addId(r);
      return true;
    },
  };
}

async function refresh() {
  await Promise.all([loadShelves(), loadGenres()]); // shelves+genres before book cards/selects
  await Promise.all([loadBooks(), loadMeta()]);
}

// ---------------------------------------------------------------------------
// Unit toggle (mm ⇄ in) — display only; storage stays in mm.
// ---------------------------------------------------------------------------
function applyUnitLabels() {
  document.querySelectorAll('.unit').forEach((el) => { el.textContent = UNIT; });
  $('#unitToggle').textContent = UNIT;
}

function toggleUnit() {
  const old = UNIT;
  UNIT = UNIT === 'mm' ? 'in' : 'mm';
  localStorage.setItem('libUnit', UNIT);
  applyUnitLabels();
  // Convert any values currently sitting in open dialog fields.
  for (const form of [bookForm, shelfForm]) {
    DIM_FIELDS.forEach((f) => {
      const el = form.elements[f];
      if (el && el.value !== '') el.value = mmToUnit(unitToMm(el.value, old), UNIT);
    });
  }
  loadBooks();
  loadShelves();
}

// ---------------------------------------------------------------------------
// Best-shelf suggester
// ---------------------------------------------------------------------------
async function suggestShelf() {
  const box = $('#suggestResult');
  const body = {
    height_mm: unitToMm(bookForm.elements.height_mm.value) || null,
    width_mm: unitToMm(bookForm.elements.width_mm.value) || null,
    thickness_mm: unitToMm(bookForm.elements.thickness_mm.value) || null,
    book_id: editingBookId || undefined,
  };
  const show = (cls, html) => { box.hidden = false; box.className = 'msg ' + cls; box.innerHTML = html; };

  if (!body.height_mm && !body.width_mm && !body.thickness_mm)
    return show('warn', 'Enter at least one dimension (height, width, or thickness) to get a suggestion.');
  if (!shelvesCache.length)
    return show('warn', 'No shelves defined yet — add shelves first.');

  try {
    const r = await api('/suggest-shelf', { method: 'POST', headers: json(), body: JSON.stringify(body) });
    if (!r.best) {
      const near = r.rejected.slice(0, 3)
        .map((x) => `${esc(shelfWhere(x))}: ${esc(x.reasons.join(', '))}`).join('<br>');
      return show('warn', `No shelf fits this book.${near ? '<br>Closest:<br>' + near : ''}`);
    }
    bookForm.elements.shelf_id.value = String(r.best.shelf_id);
    checkFit();
    const rest = r.suggestions.slice(1, 3).map((x) => `<li>${esc(shelfWhere(x))} — ${fitDesc(x)}</li>`).join('');
    show('ok', `✨ Best: <strong>${esc(shelfWhere(r.best))}</strong> (${fitDesc(r.best)}). Selected it above.` +
      (rest ? `<ul class="sug-list">${rest}</ul>` : ''));
  } catch (err) {
    show('err', esc(err.message));
  }
}

const shelfWhere = (x) => [x.room, x.bookcase, x.label].filter(Boolean).join(' › ');
function fitDesc(x) {
  const head = x.height_headroom_mm != null ? `${dispDim(x.height_headroom_mm)} ${UNIT} headroom` : 'height n/a';
  const free = x.free_width_mm != null ? `${dispDim(x.free_width_mm)} ${UNIT} free` : 'width n/a';
  return `${head}, ${free}`;
}

// ---------------------------------------------------------------------------
// Helpers & wiring
// ---------------------------------------------------------------------------
const json = () => ({ 'Content-Type': 'application/json' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.placeholderCover = placeholderCover;

let searchTimer;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBooks, 250); });
['#filterStatus', '#filterFormat', '#filterGenre', '#filterRoom', '#filterBookcase', '#filterShelf']
  .forEach((s) => $(s).addEventListener('change', loadBooks));
$('#clearFiltersBtn').addEventListener('click', clearFilters);

$('#addBtn').onclick = openAddBook; // reassigned per-tab by the tab handler
$('#addShelfBtn').addEventListener('click', openAddShelf);
$('#unitToggle').addEventListener('click', toggleUnit);
$('#suggestBtn').addEventListener('click', suggestShelf);
$('#closeDialog').addEventListener('click', closeBookDialog);
$('#cancelBtn').addEventListener('click', closeBookDialog);
$('#lookupBtn').addEventListener('click', lookup);
$('#scanBtn').addEventListener('click', onScanButton);
$('#importBtn').addEventListener('click', () => { closeBookDialog(); openImportDialog(); });
$('#importRunBtn').addEventListener('click', runImport);
$('#importCloseBtn').addEventListener('click', () => $('#importDialog').close());
$('#closeImportDialog').addEventListener('click', () => $('#importDialog').close());
$('#coverCameraBtn').addEventListener('click', () => $('#coverCameraFile').click());
$('#coverUploadBtn').addEventListener('click', () => $('#coverUploadFile').click());
$('#coverCameraFile').addEventListener('change', onCoverFile);
$('#coverUploadFile').addEventListener('change', onCoverFile);
$('#cropRotate').addEventListener('click', () => { if (cropper) cropper.rotate(90); });
$('#cropUse').addEventListener('click', useCroppedCover);
$('#cropCancel').addEventListener('click', closeCropDialog);
$('#closeCropDialog').addEventListener('click', closeCropDialog);
cropDialog.addEventListener('cancel', (e) => { e.preventDefault(); closeCropDialog(); });
$('#deleteBtn').addEventListener('click', deleteBook);
$('#statusSelect').addEventListener('change', syncBookFields);
$('#isLibraryBook').addEventListener('change', syncBookFields);
$('#shelfSelect').addEventListener('change', checkFit);
['height_mm', 'width_mm', 'thickness_mm'].forEach((n) => bookForm.elements[n].addEventListener('input', checkFit));
bookForm.addEventListener('submit', saveBook);
bookDialog.addEventListener('cancel', () => stopScanner());

$('#closeShelfDialog').addEventListener('click', () => shelfDialog.close());
$('#cancelShelfBtn').addEventListener('click', () => shelfDialog.close());
$('#deleteShelfBtn').addEventListener('click', deleteShelf);
shelfForm.addEventListener('submit', saveShelf);

// Autocomplete for the free-text classification/location fields.
// Single multi-select genres field (id-based, backed by book_genres).
genreTags = createGenreField($('#genreInput'));
$('#addGenreBtn').addEventListener('click', openAddGenre);
$('#closeGenreDialog').addEventListener('click', () => genreDialog.close());
$('#cancelGenreBtn').addEventListener('click', () => genreDialog.close());
$('#deleteGenreBtn').addEventListener('click', deleteGenre);
genreForm.addEventListener('submit', saveGenre);
attachCombo(shelfForm.elements.room, () => META.rooms);
attachCombo(shelfForm.elements.bookcase, () => META.bookcases);

applyUnitLabels();
refresh().catch((err) => alert('Failed to load: ' + err.message));
