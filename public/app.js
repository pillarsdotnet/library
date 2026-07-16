'use strict';

const $ = (sel) => document.querySelector(sel);
// Relative to the document <base>, so the app works under any mount path (/library).
const api = (path, opts) => fetch('api' + path, opts).then(async (r) => {
  if (!r.ok && r.status !== 204) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.status === 204 ? null : r.json();
});

const STATUS_LABELS = { tbr: 'To be read', reading: 'Reading', read: 'Read', loaned: 'Loaned out' };
const FORMAT_LABELS = { paperback: 'Paperback', hardback: 'Hardback', ebook: 'E-book', audiobook: 'Audiobook', other: 'Other' };

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

let editingBookId = null;
let editingShelfId = null;
let scanner = null;
let shelvesCache = [];

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#tab-books').hidden = tab.dataset.tab !== 'books';
    $('#tab-shelves').hidden = tab.dataset.tab !== 'shelves';
    $('#addBtn').textContent = tab.dataset.tab === 'books' ? '+ Add book' : '+ Add shelf';
    $('#addBtn').onclick = tab.dataset.tab === 'books' ? openAddBook : openAddShelf;
  });
});

// ---------------------------------------------------------------------------
// Books listing
// ---------------------------------------------------------------------------
async function loadBooks() {
  const params = new URLSearchParams();
  if ($('#search').value) params.set('q', $('#search').value);
  if ($('#filterStatus').value) params.set('status', $('#filterStatus').value);
  if ($('#filterRoom').value) params.set('room', $('#filterRoom').value);
  if ($('#filterGenre').value) params.set('genre', $('#filterGenre').value);
  if ($('#filterShelf').value) params.set('shelf_id', $('#filterShelf').value);

  const books = await api('/books?' + params.toString());
  const list = $('#list');
  list.innerHTML = '';
  $('#empty').hidden = books.length > 0;
  for (const b of books) list.appendChild(renderBookCard(b));
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
      ${location ? `<p class="loc">📍 ${esc(location)}</p>` : '<p class="loc muted-text">Unshelved</p>'}
      ${dims ? `<p class="loc">📐 ${dims}</p>` : ''}
      ${b.status === 'loaned' && b.loaned_to ? `<p class="loc">👤 ${esc(b.loaned_to)}</p>` : ''}
      ${b.is_library_book && b.due_date ? `<p class="loc due">⏰ Due ${esc(b.due_date)}</p>` : ''}
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
  if (s.unknown_thickness) flags.push(`${s.unknown_thickness} missing thickness`);

  card.innerHTML = `
    <div class="card-body grow">
      <h3>${esc(s.label)}</h3>
      ${heading ? `<p class="authors">${esc(heading)}</p>` : ''}
      <p class="loc">📐 ${s.width_mm ? dispDim(s.width_mm) + ' W' : '—'} × ${s.height_mm ? dispDim(s.height_mm) + ' H' : '—'} × ${s.depth_mm ? dispDim(s.depth_mm) + ' D' : '—'} ${UNIT}</p>
      ${capacity}
      ${flags.length ? `<div class="badges">${flags.map((f) => `<span class="badge muted">${f}</span>`).join('')}</div>` : ''}
      <div class="shelf-actions">
        <button type="button" class="link" data-view="${s.id}">View books</button>
        <button type="button" class="link" data-edit="${s.id}">Edit</button>
      </div>
    </div>`;

  card.querySelector('[data-view]').onclick = () => viewShelfBooks(s.id);
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
  DIM_FIELDS.forEach((f) => { if (bookForm.elements[f]) bookForm.elements[f].value = mmToUnit(book[f]); });
  showCover(book.cover_url);
  $('#lookupMsg').hidden = true;
  $('#suggestResult').hidden = true;
  syncBookFields();
  bookDialog.showModal();
}

function showCover(url) {
  const img = $('#coverPreview');
  if (url) { img.src = url; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
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

async function saveBook(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(bookForm).entries());
  data.is_library_book = $('#isLibraryBook').checked;
  DIM_FIELDS.forEach((f) => { if (f in data) data[f] = unitToMm(data[f]); });
  try {
    if (editingBookId) await api('/books/' + editingBookId, { method: 'PUT', headers: json(), body: JSON.stringify(data) });
    else await api('/books', { method: 'POST', headers: json(), body: JSON.stringify(data) });
    closeBookDialog();
    await refresh();
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
function populateShelfSelect() {
  const sel = $('#shelfSelect');
  const current = sel.value;
  const groups = {};
  for (const s of shelvesCache) {
    const key = [s.room, s.bookcase].filter(Boolean).join(' › ') || 'Other';
    (groups[key] ||= []).push(s);
  }
  sel.innerHTML = '<option value="">— Unshelved —</option>';
  for (const [group, items] of Object.entries(groups)) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const s of items) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.label;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = current;
}

function populateShelfFilter() {
  const sel = $('#filterShelf');
  const current = sel.value;
  sel.innerHTML = '<option value="">All shelves</option><option value="none">Unshelved</option>' +
    shelvesCache.map((s) => `<option value="${s.id}">${esc([s.room, s.bookcase, s.label].filter(Boolean).join(' › '))}</option>`).join('');
  sel.value = current;
}

// ---------------------------------------------------------------------------
// ISBN lookup + scanning
// ---------------------------------------------------------------------------
async function lookup() {
  const isbn = $('#isbn').value.trim();
  if (!isbn) return;
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
    const gotDims = d.height_mm || d.thickness_mm;
    msg.textContent = `Found via ${d.source}.` + (gotDims ? ' Dimensions included.' : ' No dimensions available — measure manually for shelf fit.');
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

async function toggleScanner() {
  if (scanner) return stopScanner();
  $('#scanner').hidden = false;
  scanner = new Html5Qrcode('scanner');
  const config = {
    fps: 10, qrbox: { width: 250, height: 150 },
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
    ],
  };
  try {
    await scanner.start({ facingMode: 'environment' }, config, onScan, () => {});
  } catch (err) {
    alert('Could not start camera: ' + err.message + '\nBrowsers require HTTPS (or localhost) for camera access.');
    stopScanner();
  }
}

function onScan(text) { $('#isbn').value = text.replace(/[^0-9Xx]/g, ''); stopScanner(); lookup(); }

async function stopScanner() {
  if (scanner) {
    try { await scanner.stop(); } catch { /* already stopped */ }
    scanner.clear(); scanner = null;
  }
  $('#scanner').hidden = true;
}

// ---------------------------------------------------------------------------
// Metadata + refresh
// ---------------------------------------------------------------------------
async function loadMeta() {
  const meta = await api('/meta');
  $('#count').textContent = `${meta.count} book${meta.count === 1 ? '' : 's'}` +
    (meta.unshelved ? ` · ${meta.unshelved} unshelved` : '');
  fillDatalist('roomList', meta.rooms);
  fillDatalist('bookcaseList', meta.bookcases);
  fillDatalist('genreList', meta.genres);
  fillDatalist('subgenreList', meta.subgenres);
  fillSelect('filterRoom', meta.rooms, 'All rooms');
  fillSelect('filterGenre', meta.genres, 'All genres');
}

function fillDatalist(id, values) {
  document.getElementById(id).innerHTML = values.map((v) => `<option value="${esc(v)}"></option>`).join('');
}
function fillSelect(id, values, allLabel) {
  const sel = document.getElementById(id);
  const current = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
  sel.value = current;
}

async function refresh() {
  await loadShelves();          // shelves first so book cards & selects have shelf data
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
['#filterStatus', '#filterRoom', '#filterGenre', '#filterShelf'].forEach((s) => $(s).addEventListener('change', loadBooks));

$('#addBtn').onclick = openAddBook; // reassigned per-tab by the tab handler
$('#addShelfBtn').addEventListener('click', openAddShelf);
$('#unitToggle').addEventListener('click', toggleUnit);
$('#suggestBtn').addEventListener('click', suggestShelf);
$('#closeDialog').addEventListener('click', closeBookDialog);
$('#cancelBtn').addEventListener('click', closeBookDialog);
$('#lookupBtn').addEventListener('click', lookup);
$('#scanBtn').addEventListener('click', toggleScanner);
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

applyUnitLabels();
refresh().catch((err) => alert('Failed to load: ' + err.message));
