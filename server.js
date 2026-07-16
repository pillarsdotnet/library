import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
// Serve the scanning library shipped via npm so the app works fully offline.
app.use('/vendor/html5-qrcode', express.static(join(__dirname, 'node_modules/html5-qrcode')));

const DEFAULT_THICKNESS_MM = 30; // fallback when estimating remaining shelf capacity

// ---------------------------------------------------------------------------
// Writable columns. Anything else in a request body is ignored.
// ---------------------------------------------------------------------------
const BOOK_COLS = [
  'isbn', 'title', 'authors', 'publisher', 'published_date', 'page_count', 'cover_url',
  'format', 'jacket', 'height_mm', 'width_mm', 'thickness_mm',
  'genre', 'subgenre', 'shelf_id',
  'status', 'loaned_to',
  'is_library_book', 'library_name', 'due_date',
  'notes',
];
const SHELF_COLS = ['room', 'bookcase', 'label', 'height_mm', 'width_mm', 'depth_mm', 'notes'];
const NUMERIC = new Set(['page_count', 'height_mm', 'width_mm', 'thickness_mm', 'depth_mm', 'shelf_id']);

function pick(body, cols) {
  const out = {};
  for (const key of cols) {
    if (body[key] === undefined) continue;
    let v = body[key];
    if (key === 'is_library_book') v = v ? 1 : 0;
    else if (NUMERIC.has(key)) v = (v === '' || v === null) ? null : Number(v);
    out[key] = v;
  }
  return out;
}

function insert(table, data) {
  const cols = Object.keys(data);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`;
  return db.prepare(sql).run(data).lastInsertRowid;
}

function update(table, id, data) {
  const cols = Object.keys(data);
  if (!cols.length) return;
  const setClause = cols.map((c) => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE ${table} SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...data, id });
}

// ---------------------------------------------------------------------------
// Books CRUD
// ---------------------------------------------------------------------------
app.get('/api/books', (req, res) => {
  const { q, status, room, genre, format, shelf_id } = req.query;
  const where = [];
  const params = {};

  if (q) {
    where.push('(b.title LIKE @q OR b.authors LIKE @q OR b.isbn LIKE @q OR b.genre LIKE @q OR b.subgenre LIKE @q)');
    params.q = `%${q}%`;
  }
  for (const [field, value] of [['status', status], ['genre', genre], ['format', format]]) {
    if (value) { where.push(`b.${field} = @${field}`); params[field] = value; }
  }
  if (room) { where.push('s.room = @room'); params.room = room; }
  if (shelf_id === 'none') where.push('b.shelf_id IS NULL');
  else if (shelf_id) { where.push('b.shelf_id = @shelf_id'); params.shelf_id = shelf_id; }

  const sql = `
    SELECT b.*, s.room, s.bookcase, s.label AS shelf_label
    FROM books b LEFT JOIN shelves s ON s.id = b.shelf_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.title COLLATE NOCASE`;
  res.json(db.prepare(sql).all(params));
});

app.get('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json(book);
});

app.post('/api/books', (req, res) => {
  const data = pick(req.body, BOOK_COLS);
  if (!data.title) return res.status(400).json({ error: 'title is required' });
  const id = insert('books', data);
  res.status(201).json(db.prepare('SELECT * FROM books WHERE id = ?').get(id));
});

app.put('/api/books/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: 'Not found' });
  update('books', req.params.id, pick(req.body, BOOK_COLS));
  res.json(db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id));
});

app.delete('/api/books/:id', (req, res) => {
  const info = db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Shelves CRUD + capacity statistics
// ---------------------------------------------------------------------------
function avgThickness() {
  return db.prepare('SELECT AVG(thickness_mm) AS t FROM books WHERE thickness_mm > 0').get().t || DEFAULT_THICKNESS_MM;
}

app.get('/api/shelves', (_req, res) => {
  const avg = avgThickness();
  const shelves = db.prepare('SELECT * FROM shelves ORDER BY room, bookcase, label COLLATE NOCASE').all();
  res.json(shelves.map((s) => ({ ...s, ...shelfStats(s, avg) })));
});

app.get('/api/shelves/:id', (req, res) => {
  const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(req.params.id);
  if (!shelf) return res.status(404).json({ error: 'Not found' });
  res.json({ ...shelf, ...shelfStats(shelf, avgThickness()) });
});

// Rank shelves by how well a book (given its dimensions) fits on them.
// Body: { height_mm, width_mm, thickness_mm, book_id? }.
// book_id lets an already-shelved book ignore its own spine when re-checking
// its current shelf (otherwise it double-counts against the free width).
app.post('/api/suggest-shelf', (req, res) => {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const h = num(req.body.height_mm);
  const w = num(req.body.width_mm);
  const t = num(req.body.thickness_mm);

  let currentShelfId = null;
  if (req.body.book_id) {
    const b = db.prepare('SELECT shelf_id, thickness_mm FROM books WHERE id = ?').get(req.body.book_id);
    if (b) currentShelfId = b.shelf_id;
  }

  const avg = avgThickness();
  const scored = db.prepare('SELECT * FROM shelves').all().map((s) => {
    const stats = shelfStats(s, avg);
    // Give the book back its own width when evaluating the shelf it already sits on.
    let free = stats.free_width_mm;
    if (free != null && s.id === currentShelfId && t) free += t;

    const reasons = [];
    if (s.height_mm && h && h > s.height_mm) reasons.push(`too tall by ${round1(h - s.height_mm)} mm`);
    if (s.depth_mm && w && w > s.depth_mm) reasons.push(`too deep by ${round1(w - s.depth_mm)} mm`);
    if (s.width_mm && t && free != null && t > free) reasons.push(`needs ${round1(t)} mm, only ${round1(free)} mm free`);

    return {
      shelf_id: s.id, label: s.label, room: s.room, bookcase: s.bookcase,
      fits: reasons.length === 0,
      reasons,
      free_width_mm: free != null ? Math.round(free) : null,
      height_headroom_mm: s.height_mm && h ? round1(s.height_mm - h) : null,
    };
  });

  // Best fit: least vertical headroom (tightest height grouping), then most free width.
  const rank = (a, b) => {
    const ha = a.height_headroom_mm == null ? Infinity : a.height_headroom_mm;
    const hb = b.height_headroom_mm == null ? Infinity : b.height_headroom_mm;
    if (ha !== hb) return ha - hb;
    return (b.free_width_mm ?? 0) - (a.free_width_mm ?? 0);
  };
  const suggestions = scored.filter((x) => x.fits).sort(rank);
  res.json({
    best: suggestions[0] || null,
    suggestions,
    rejected: scored.filter((x) => !x.fits),
  });
});

app.post('/api/shelves', (req, res) => {
  const data = pick(req.body, SHELF_COLS);
  if (!data.label) return res.status(400).json({ error: 'label is required' });
  const id = insert('shelves', data);
  res.status(201).json(db.prepare('SELECT * FROM shelves WHERE id = ?').get(id));
});

app.put('/api/shelves/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM shelves WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: 'Not found' });
  update('shelves', req.params.id, pick(req.body, SHELF_COLS));
  res.json(db.prepare('SELECT * FROM shelves WHERE id = ?').get(req.params.id));
});

app.delete('/api/shelves/:id', (req, res) => {
  // Books on this shelf become unshelved (ON DELETE SET NULL).
  const info = db.prepare('DELETE FROM shelves WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// Given a shelf row, compute how full it is and flag books that don't fit.
function shelfStats(shelf, avgThickness) {
  const books = db.prepare('SELECT height_mm, width_mm, thickness_mm FROM books WHERE shelf_id = ?').all(shelf.id);
  let usedWidth = 0;
  let unknownThickness = 0;
  let tooTall = 0;
  let tooDeep = 0;

  for (const b of books) {
    if (b.thickness_mm > 0) usedWidth += b.thickness_mm;
    else unknownThickness++;
    if (shelf.height_mm && b.height_mm && b.height_mm > shelf.height_mm) tooTall++;
    if (shelf.depth_mm && b.width_mm && b.width_mm > shelf.depth_mm) tooDeep++;
  }

  const freeWidth = shelf.width_mm != null ? shelf.width_mm - usedWidth : null;
  return {
    book_count: books.length,
    used_width_mm: Math.round(usedWidth),
    free_width_mm: freeWidth != null ? Math.round(freeWidth) : null,
    fill_pct: shelf.width_mm ? Math.round((usedWidth / shelf.width_mm) * 100) : null,
    est_additional: freeWidth != null && freeWidth > 0 ? Math.floor(freeWidth / avgThickness) : 0,
    overfull: freeWidth != null && freeWidth < 0,
    unknown_thickness: unknownThickness,
    too_tall: tooTall,
    too_deep: tooDeep,
  };
}

// ---------------------------------------------------------------------------
// Distinct values for autocomplete / filters.
// ---------------------------------------------------------------------------
app.get('/api/meta', (_req, res) => {
  const distinct = (table, col) =>
    db.prepare(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != '' ORDER BY v COLLATE NOCASE`)
      .all().map((r) => r.v);
  res.json({
    rooms: distinct('shelves', 'room'),
    bookcases: distinct('shelves', 'bookcase'),
    genres: distinct('books', 'genre'),
    subgenres: distinct('books', 'subgenre'),
    count: db.prepare('SELECT COUNT(*) AS n FROM books').get().n,
    unshelved: db.prepare('SELECT COUNT(*) AS n FROM books WHERE shelf_id IS NULL').get().n,
  });
});

// ---------------------------------------------------------------------------
// ISBN lookup — merges Open Library and Google Books, incl. physical size.
// ---------------------------------------------------------------------------
app.get('/api/lookup/:isbn', async (req, res) => {
  const isbn = req.params.isbn.replace(/[^0-9Xx]/g, '');
  if (!isbn) return res.status(400).json({ error: 'invalid isbn' });

  try {
    const [openlib, google] = await Promise.allSettled([fetchOpenLibrary(isbn), fetchGoogleBooks(isbn)]);
    const ol = openlib.status === 'fulfilled' ? openlib.value : null;
    const gb = google.status === 'fulfilled' ? google.value : null;
    if (!ol && !gb) return res.status(404).json({ error: 'No metadata found for this ISBN' });

    const first = (...vals) => vals.find((v) => v != null && v !== '') ?? '';
    res.json({
      isbn,
      title: first(ol?.title, gb?.title),
      authors: first(ol?.authors, gb?.authors),
      publisher: first(ol?.publisher, gb?.publisher),
      published_date: first(ol?.published_date, gb?.published_date),
      page_count: first(ol?.page_count, gb?.page_count) || null,
      cover_url: first(ol?.cover_url, gb?.cover_url),
      height_mm: ol?.height_mm ?? gb?.height_mm ?? null,
      width_mm: ol?.width_mm ?? gb?.width_mm ?? null,
      thickness_mm: ol?.thickness_mm ?? gb?.thickness_mm ?? null,
      source: ol ? 'openlibrary' : 'googlebooks',
    });
  } catch (err) {
    console.error('lookup failed', err);
    res.status(502).json({ error: 'Lookup service failed' });
  }
});

// Parse strings like "9.1 x 6.1 x 1.2 inches" or "24.00 cm" into millimetres.
function toMm(value) {
  if (!value) return null;
  const m = String(value).match(/([\d.]+)\s*(cm|mm|inch|inches|in|")?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const unit = (m[2] || 'cm').toLowerCase();
  if (unit === 'mm') return round1(n);
  if (unit === 'cm') return round1(n * 10);
  return round1(n * 25.4); // inches
}
const round1 = (n) => Math.round(n * 10) / 10;

async function fetchOpenLibrary(isbn) {
  const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  if (!r.ok) return null;
  const data = (await r.json())[`ISBN:${isbn}`];
  if (!data) return null;

  // e.g. "20.3 x 13.3 x 2.5 centimeters"
  let h = null, w = null, t = null;
  if (data.dimensions) {
    const parts = String(data.dimensions).split(/x|×/);
    const unit = /inch/i.test(data.dimensions) ? 'inch' : /mm/i.test(data.dimensions) ? 'mm' : 'cm';
    const nums = parts.map((p) => toMm(p.trim().replace(/[a-z"]/gi, '') + ' ' + unit)).filter((n) => n != null);
    [h, w, t] = [nums[0] ?? null, nums[1] ?? null, nums[2] ?? null];
  }
  return {
    title: data.title,
    authors: (data.authors || []).map((a) => a.name).join(', '),
    publisher: (data.publishers || []).map((p) => p.name).join(', '),
    published_date: data.publish_date,
    page_count: data.number_of_pages || null,
    cover_url: data.cover?.large || data.cover?.medium || data.cover?.small || '',
    height_mm: h, width_mm: w, thickness_mm: t,
  };
}

async function fetchGoogleBooks(isbn) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
  if (!r.ok) return null;
  const vol = (await r.json()).items?.[0]?.volumeInfo;
  if (!vol) return null;
  const d = vol.dimensions || {};
  return {
    title: vol.title + (vol.subtitle ? `: ${vol.subtitle}` : ''),
    authors: (vol.authors || []).join(', '),
    publisher: vol.publisher || '',
    published_date: vol.publishedDate || '',
    page_count: vol.pageCount || null,
    cover_url: (vol.imageLinks?.thumbnail || '').replace('http://', 'https://'),
    height_mm: toMm(d.height), width_mm: toMm(d.width), thickness_mm: toMm(d.thickness),
  };
}

app.listen(PORT, () => console.log(`📚 Home Library running on http://localhost:${PORT}`));
