import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import db from './db.js';
import { lookupIsbn, RateLimitError } from './lookup.js';
import { parseEpub } from './epub.js';
import {
  fetchEdition, proposalsFor, login, sendField, sendCover,
  haveCredentials, FIELD_LABELS, FIELD_COMMENTS,
} from './openlibrary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
// Sub-path the whole app is served under, e.g. "/library". Empty = root.
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');

app.use(express.json({ limit: '6mb' })); // headroom for uploaded (data-URL) covers

// Everything (UI + API) hangs off this router so it can be mounted under BASE.
const router = express.Router();

// Serve index.html with the right <base> href injected for the mount point,
// so every relative asset/API URL resolves under BASE regardless of the host.
const indexHtml = readFileSync(join(__dirname, 'public/index.html'), 'utf8');
router.get('/', (_req, res) => res.type('html').send(indexHtml.replace('__BASE__', BASE)));

router.use(express.static(join(__dirname, 'public'), { index: false }));
// Serve the scanning libraries shipped via npm so the app works fully offline.
router.use('/vendor/html5-qrcode', express.static(join(__dirname, 'node_modules/html5-qrcode')));
router.use('/vendor/quagga', express.static(join(__dirname, 'node_modules/@ericblade/quagga2/dist')));
router.use('/vendor/cropper', express.static(join(__dirname, 'node_modules/cropperjs/dist')));

const DEFAULT_THICKNESS_MM = 30; // fallback when estimating remaining shelf capacity
const DEFAULT_PAGE = 20;         // books per page unless the client asks otherwise

// Replace an inline data: cover with a reference to the cover endpoint, so list
// responses stay small. Relative on purpose: it resolves against the <base href>.
// The reference carries a token derived from the image itself. Without it the
// URL for a book's cover never changes, so a browser holding a cached copy goes
// on showing the old photo after a new one is saved — which looks exactly like
// the save having failed.
const coverToken = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
};
const coverRef = (b) => {
  if (b && typeof b.cover_url === 'string' && b.cover_url.startsWith('data:')) {
    b.cover_url = `api/books/${b.id}/cover?v=${coverToken(b.cover_url)}`;
  }
  // The kept-back original is big and wanted only when re-cropping, so it
  // travels as a reference and never as bytes in a listing.
  if (b && typeof b.cover_source === 'string' && b.cover_source) {
    b.cover_source = `api/books/${b.id}/cover-source?v=${coverToken(b.cover_source)}`;
  }
  return b;
};
// A client echoing either reference back on save must not overwrite the image.
const isCoverRef = (v) => typeof v === 'string' && /(^|\/)api\/books\/\d+\/cover(-source)?(\?.*)?$/.test(v);
const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Writable columns. Anything else in a request body is ignored.
// ---------------------------------------------------------------------------
const BOOK_COLS = [
  'isbn', 'title', 'authors', 'publisher', 'published_date', 'page_count', 'cover_url', 'cover_source',
  'format', 'jacket', 'height_mm', 'width_mm', 'thickness_mm',
  'shelf_id',
  'status', 'loaned_to',
  'is_library_book', 'library_name', 'due_date',
  'source', 'notes',
];
const SHELF_COLS = ['room', 'bookcase', 'label', 'height_mm', 'width_mm', 'depth_mm', 'notes'];
const NUMERIC = new Set(['page_count', 'height_mm', 'width_mm', 'thickness_mm', 'depth_mm', 'shelf_id']);
// Dimensions are whole millimetres; round whatever a client sends.
const MM_COLS = new Set(['height_mm', 'width_mm', 'thickness_mm', 'depth_mm']);

function pick(body, cols) {
  const out = {};
  for (const key of cols) {
    if (body[key] === undefined) continue;
    let v = body[key];
    if (key === 'is_library_book') v = v ? 1 : 0;
    else if (NUMERIC.has(key)) {
      v = (v === '' || v === null) ? null : Number(v);
      if (v !== null && MM_COLS.has(key)) v = Math.round(v);
    }
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

// Replace a book's genres with the given list of genre ids (ignores unknown ids).
function setBookGenres(bookId, genreIds) {
  if (!Array.isArray(genreIds)) return;
  db.prepare('DELETE FROM book_genres WHERE book_id = ?').run(bookId);
  const link = db.prepare('INSERT OR IGNORE INTO book_genres (book_id, genre_id) VALUES (?, ?)');
  const known = db.prepare('SELECT id FROM genres WHERE id = ?');
  for (const gid of genreIds) {
    const n = Number(gid);
    if (n && known.get(n)) link.run(bookId, n);
  }
}

// Attach each book's genres (id + name + parent_id) to the given rows.
function attachGenres(books) {
  if (!books.length) return books;
  const rows = db.prepare(`
    SELECT bg.book_id, g.id, g.name, g.parent_id
    FROM book_genres bg JOIN genres g ON g.id = bg.genre_id
    ORDER BY g.name COLLATE NOCASE`).all();
  const byBook = new Map();
  for (const r of rows) {
    if (!byBook.has(r.book_id)) byBook.set(r.book_id, []);
    byBook.get(r.book_id).push({ id: r.id, name: r.name, parent_id: r.parent_id });
  }
  // A book may hold several positions (an omnibus), so collect them per book.
  const seriesRows = db.prepare(`
    SELECT sb.book, sb.series AS series_id, sb."order" AS "order", s.title
    FROM series_books sb JOIN series s ON s.id = sb.series
    ORDER BY sb."order"`).all();
  const seriesByBook = new Map();
  for (const r of seriesRows) {
    if (!seriesByBook.has(r.book)) seriesByBook.set(r.book, { series_id: r.series_id, title: r.title, orders: [] });
    seriesByBook.get(r.book).orders.push(r.order);
  }
  for (const v of seriesByBook.values()) v.order = v.orders[0];   // earliest position
  for (const b of books) {
    b.genres = byBook.get(b.id) || [];
    b.genre_ids = b.genres.map((g) => g.id);
    b.series = seriesByBook.get(b.id) || null;
  }
  return books;
}

router.get('/api/books', (req, res) => {
  const { q, status, room, bookcase, genre_id, series_id, format, shelf_id } = req.query;
  const where = [];
  const params = {};

  if (q) {
    where.push('(b.title LIKE @q OR b.authors LIKE @q OR b.isbn LIKE @q)');
    params.q = `%${q}%`;
  }
  for (const [field, value] of [['status', status], ['format', format]]) {
    if (value) { where.push(`b.${field} = @${field}`); params[field] = value; }
  }
  if (genre_id === 'none') {
    where.push('NOT EXISTS (SELECT 1 FROM book_genres bg WHERE bg.book_id = b.id)');
  } else if (genre_id) {
    where.push('EXISTS (SELECT 1 FROM book_genres bg WHERE bg.book_id = b.id AND bg.genre_id = @genre_id)');
    params.genre_id = Number(genre_id);
  }
  if (series_id === 'none') {
    where.push('NOT EXISTS (SELECT 1 FROM series_books sb WHERE sb.book = b.id)');
  } else if (series_id) {
    where.push('EXISTS (SELECT 1 FROM series_books sb WHERE sb.book = b.id AND sb.series = @series_id)');
    params.series_id = Number(series_id);
  }
  if (room) { where.push('s.room = @room'); params.room = room; }
  if (bookcase) { where.push('s.bookcase = @bookcase'); params.bookcase = bookcase; }
  if (shelf_id === 'none') where.push('b.shelf_id IS NULL');
  else if (shelf_id) { where.push('b.shelf_id = @shelf_id'); params.shelf_id = shelf_id; }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const from = `FROM books b LEFT JOIN shelves s ON s.id = b.shelf_id ${whereSql}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(params).n;

  // Paginated by default so the list stays small; limit=0 returns everything.
  const limit = req.query.limit === undefined ? DEFAULT_PAGE : Math.max(0, Number(req.query.limit) || 0);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const page = limit > 0 ? ` LIMIT ${limit} OFFSET ${offset}` : '';

  // Filtering to one series reads far better in reading order than alphabetically:
  // by lowest position, then highest (so "book 1" precedes "books 1-5", which
  // precedes "books 1-15"), then by where the copy lives, shelved copies first.
  const orderBy = (series_id && series_id !== 'none')
    ? `(SELECT MIN(sb."order") FROM series_books sb WHERE sb.book = b.id AND sb.series = @series_id),
       (SELECT MAX(sb."order") FROM series_books sb WHERE sb.book = b.id AND sb.series = @series_id),
       s.room IS NULL, s.room COLLATE NOCASE, s.bookcase COLLATE NOCASE, s.label COLLATE NOCASE,
       sort_title(b.title)`
    : 'sort_title(b.title)';
  const sql = `SELECT b.*, s.room, s.bookcase, s.label AS shelf_label ${from}
    ORDER BY ${orderBy}${page}`;
  res.set('X-Total-Count', String(total));
  res.json(attachGenres(db.prepare(sql).all(params)).map(coverRef));
});

// Inline (data:) covers are served from their own endpoint instead of being
// embedded in every list response — they dominated the payload otherwise.
router.get('/api/books/:id/cover', (req, res) => {
  const row = db.prepare('SELECT cover_url FROM books WHERE id = ?').get(req.params.id);
  if (!row || !row.cover_url) return res.status(404).json({ error: 'Not found' });
  if (!row.cover_url.startsWith('data:')) return res.redirect(302, row.cover_url);
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(row.cover_url);
  if (!m) return res.status(404).json({ error: 'Not an inline image' });
  res.set('Content-Type', m[1]);
  // A versioned URL names one particular image, so it can be cached hard: a new
  // photo arrives under a new URL. Bare URLs must stay short-lived, or a saved
  // cover would appear not to have changed.
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.send(Buffer.from(m[2], 'base64'));
});

// The photo a cover was cropped from, for re-cropping it later.
router.get('/api/books/:id/cover-source', (req, res) => {
  const row = db.prepare('SELECT cover_source FROM books WHERE id = ?').get(req.params.id);
  if (!row || !row.cover_source) return res.status(404).json({ error: 'Not found' });
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(row.cover_source);
  if (!m) return res.status(404).json({ error: 'Not an inline image' });
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.send(Buffer.from(m[2], 'base64'));
});

router.get('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json(coverRef(attachGenres([book])[0]));
});

router.post('/api/books', (req, res) => {
  if (isCoverRef(req.body.cover_url)) delete req.body.cover_url;
  if (isCoverRef(req.body.cover_source)) delete req.body.cover_source;
  const data = pick(req.body, BOOK_COLS);
  if (!data.title) return res.status(400).json({ error: 'title is required' });
  const id = insert('books', data);
  if (req.body.genre_ids !== undefined) setBookGenres(id, req.body.genre_ids);
  res.status(201).json(coverRef(attachGenres([db.prepare('SELECT * FROM books WHERE id = ?').get(id)])[0]));
});

router.put('/api/books/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: 'Not found' });
  // The client may echo back "api/books/:id/cover"; that means "unchanged".
  if (isCoverRef(req.body.cover_url)) delete req.body.cover_url;
  if (isCoverRef(req.body.cover_source)) delete req.body.cover_source;
  update('books', req.params.id, pick(req.body, BOOK_COLS));
  if (req.body.genre_ids !== undefined) setBookGenres(req.params.id, req.body.genre_ids);
  res.json(coverRef(attachGenres([db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id)])[0]));
});

router.delete('/api/books/:id', (req, res) => {
  const info = db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Contributing back to Open Library, through a review queue.
//
// Scanning only ever proposes; sending happens when a human approves a row.
// See openlibrary.js for the two rules that govern what may be proposed.
// ---------------------------------------------------------------------------

// Look at books with an ISBN and queue up anything Open Library is missing that
// we can answer. Books already fully proposed cost one request each, so this is
// deliberately a button rather than something that runs on every save.
router.post('/api/ol-contributions/scan', async (req, res) => {
  const limit = Math.min(Number(req.body?.limit) || 25, 100);
  // The series tag names a series, not a position, so one title per book is all
  // that is ever sent — the lowest-ordered one when a book sits in several.
  const books = db.prepare(`
    SELECT b.*, (
      SELECT s.title FROM series_books sb JOIN series s ON s.id = sb.series
      WHERE sb.book = b.id ORDER BY sb."order" LIMIT 1
    ) AS series_title
    FROM books b
    WHERE b.isbn IS NOT NULL AND b.isbn <> ''
    ORDER BY b.updated_at DESC LIMIT ?`).all(limit);
  const already = db.prepare('SELECT 1 FROM ol_contributions WHERE book_id = ? AND field = ?');
  const add = db.prepare(`INSERT OR IGNORE INTO ol_contributions (book_id, olid, field, value)
                          VALUES (?, ?, ?, ?)`);
  let scanned = 0, queued = 0, unknown = 0;
  for (const book of books) {
    let edition = null;
    try { edition = await fetchEdition(book.isbn); } catch { edition = null; }
    scanned += 1;
    if (!edition) { unknown += 1; continue; }   // no OL edition: nothing to add to
    for (const p of proposalsFor(book, edition.record, edition.work)) {
      if (already.get(book.id, p.field)) continue;
      // Each proposal records the record it would edit: the series tag belongs
      // to the work, everything else to the edition.
      add.run(book.id, p.target === 'work' ? edition.workOlid : edition.olid, p.field, p.value);
      queued += 1;
    }
  }
  res.json({ scanned, queued, unknown });
});

router.get('/api/ol-contributions', (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare(`
    SELECT c.*, b.title, b.authors, b.isbn
    FROM ol_contributions c JOIN books b ON b.id = c.book_id
    WHERE c.status = ? ORDER BY b.title, c.field`).all(status);
  res.json(rows.map((r) => ({ ...r, label: FIELD_LABELS[r.field] || r.field })));
});

router.get('/api/ol-contributions/status', (_req, res) => {
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM ol_contributions GROUP BY status').all();
  res.json({
    configured: haveCredentials(),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  });
});

router.post('/api/ol-contributions/:id/decline', (req, res) => {
  const info = db.prepare(`UPDATE ol_contributions
    SET status = 'declined', reviewed_at = datetime('now')
    WHERE id = ? AND status IN ('pending', 'failed')`).run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Approving is sending: the queue is the review gate, so there is no second
// confirmation. A failure leaves the row visible with its reason attached
// rather than swallowing it, so it can be retried or declined.
router.post('/api/ol-contributions/:id/approve', async (req, res) => {
  const row = db.prepare(`SELECT c.*, b.cover_url FROM ol_contributions c
                          JOIN books b ON b.id = c.book_id
                          WHERE c.id = ? AND c.status IN ('pending', 'failed')`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!haveCredentials()) return res.status(503).json({ error: 'Open Library credentials are not configured' });

  try {
    const cookie = await login();
    if (row.field === 'cover') {
      const m = /^data:[^;,]+;base64,(.*)$/s.exec(row.cover_url || '');
      if (!m) throw new Error('this book no longer has an uploaded cover to send');
      await sendCover(row.olid, Buffer.from(m[1], 'base64'), cookie);
    } else {
      await sendField(row.olid, row.field, row.value, FIELD_COMMENTS[row.field], cookie);
    }
    db.prepare(`UPDATE ol_contributions SET status = 'sent', error = NULL,
                reviewed_at = datetime('now') WHERE id = ?`).run(row.id);
    res.json({ ok: true, olid: row.olid });
  } catch (e) {
    db.prepare(`UPDATE ol_contributions SET status = 'failed', error = ?,
                reviewed_at = datetime('now') WHERE id = ?`).run(e.message, row.id);
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Shelves CRUD + capacity statistics
// ---------------------------------------------------------------------------
function avgThickness() {
  return db.prepare('SELECT AVG(thickness_mm) AS t FROM books WHERE thickness_mm > 0').get().t || DEFAULT_THICKNESS_MM;
}

router.get('/api/shelves', (_req, res) => {
  const avg = avgThickness();
  const shelves = db.prepare('SELECT * FROM shelves ORDER BY room, bookcase, label COLLATE NOCASE').all();
  res.json(shelves.map((s) => ({ ...s, ...shelfStats(s, avg) })));
});

router.get('/api/shelves/:id', (req, res) => {
  const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(req.params.id);
  if (!shelf) return res.status(404).json({ error: 'Not found' });
  res.json({ ...shelf, ...shelfStats(shelf, avgThickness()) });
});

// Rank shelves by how well a book (given its dimensions) fits on them.
// Body: { height_mm, width_mm, thickness_mm, book_id? }.
// book_id lets an already-shelved book ignore its own spine when re-checking
// its current shelf (otherwise it double-counts against the free width).
router.post('/api/suggest-shelf', (req, res) => {
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

router.post('/api/shelves', (req, res) => {
  const data = pick(req.body, SHELF_COLS);
  if (!data.label) return res.status(400).json({ error: 'label is required' });
  const id = insert('shelves', data);
  res.status(201).json(db.prepare('SELECT * FROM shelves WHERE id = ?').get(id));
});

router.put('/api/shelves/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM shelves WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: 'Not found' });
  update('shelves', req.params.id, pick(req.body, SHELF_COLS));
  res.json(db.prepare('SELECT * FROM shelves WHERE id = ?').get(req.params.id));
});

router.delete('/api/shelves/:id', (req, res) => {
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
router.get('/api/meta', (_req, res) => {
  const distinct = (table, col) =>
    db.prepare(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != '' ORDER BY v COLLATE NOCASE`)
      .all().map((r) => r.v);
  res.json({
    rooms: distinct('shelves', 'room'),
    bookcases: distinct('shelves', 'bookcase'),
    count: db.prepare('SELECT COUNT(*) AS n FROM books').get().n,
    unshelved: db.prepare('SELECT COUNT(*) AS n FROM books WHERE shelf_id IS NULL').get().n,
  });
});

// ---------------------------------------------------------------------------
// Series — a named series and the ordered books within it.
// ---------------------------------------------------------------------------

// Accepts 4, [1,2], "1,3,5", "1-5" or "1-3, 7" and returns sorted unique
// positions. A single volume can collect several books in a series.
function parseOrders(value) {
  const out = new Set();
  const add = (n) => { if (Number.isInteger(n) && n >= 1) out.add(n); };
  const token = (tok) => {
    const s = String(tok).trim();
    const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(s);
    if (!range) return add(Number(s));
    let [, lo, hi] = range.map(Number);
    if (lo > hi) [lo, hi] = [hi, lo];
    if (hi - lo > 500) return;            // guard against a runaway range
    for (let n = lo; n <= hi; n += 1) add(n);
  };
  if (Array.isArray(value)) value.forEach(token);
  else String(value ?? '').split(',').forEach(token);
  return [...out].sort((a, b) => a - b);
}
router.get('/api/series', (_req, res) => {
  res.json(db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM series_books sb WHERE sb.series = s.id) AS book_count
    FROM series s ORDER BY s.title COLLATE NOCASE`).all());
});

// Find-or-create by title (case-insensitive), so typing an existing name reuses it.
router.post('/api/series', (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  const existing = db.prepare('SELECT * FROM series WHERE title = ? COLLATE NOCASE').get(title);
  if (existing) return res.status(200).json(existing);
  const id = db.prepare('INSERT INTO series (title) VALUES (?)').run(title).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM series WHERE id = ?').get(id));
});

router.get('/api/series/:id/books', (req, res) => {
  res.json(db.prepare(`
    SELECT sb."order" AS "order", b.*
    FROM series_books sb JOIN books b ON b.id = sb.book
    WHERE sb.series = ? ORDER BY sb."order", sort_title(b.title)`).all(req.params.id));
});

// Place a book in a series at a given order. The order is simply "which book in
// the series this is", so it is stored exactly as given: duplicates are allowed
// (the same volume in several formats) and gaps are allowed (owning #1 and #3).
router.post('/api/series/:id/books', (req, res) => {
  const seriesId = Number(req.params.id);
  if (!db.prepare('SELECT id FROM series WHERE id = ?').get(seriesId)) {
    return res.status(404).json({ error: 'series not found' });
  }
  const bookId = Number(req.body.book_id);
  if (!bookId || !db.prepare('SELECT id FROM books WHERE id = ?').get(bookId)) {
    return res.status(400).json({ error: 'valid book_id is required' });
  }
  const orders = parseOrders(req.body.orders ?? req.body.order);
  if (!orders.length) {
    return res.status(400).json({ error: 'order must be a positive integer, list or range (e.g. 3, "1,3" or "1-5")' });
  }

  const place = db.transaction(() => {
    // Re-placing the same book replaces all of its positions in this series.
    db.prepare('DELETE FROM series_books WHERE series = ? AND book = ?').run(seriesId, bookId);
    const ins = db.prepare('INSERT INTO series_books (series, "order", book) VALUES (?, ?, ?)');
    for (const o of orders) ins.run(seriesId, o, bookId);
  });
  place();
  res.status(201).json(db.prepare(`
    SELECT sb."order" AS "order", b.id, b.title
    FROM series_books sb JOIN books b ON b.id = sb.book
    WHERE sb.series = ? ORDER BY sb."order", sort_title(b.title)`).all(seriesId));
});

// Removing a book leaves the other orders alone: they are the books' numbers in
// the series, not positions in a list (renumbering would be wrong when several
// editions share a number).
router.delete('/api/series/:id/books/:bookId', (req, res) => {
  const info = db.prepare('DELETE FROM series_books WHERE series = ? AND book = ?').run(Number(req.params.id), req.params.bookId);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Genres — hierarchical taxonomy (parent_id NULL = top-level, else a subgenre).
// ---------------------------------------------------------------------------
router.get('/api/genres', (_req, res) => {
  res.json(db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM book_genres bg WHERE bg.genre_id = g.id) AS book_count
    FROM genres g ORDER BY g.name COLLATE NOCASE`).all());
});

router.post('/api/genres', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (parentId && !db.prepare('SELECT id FROM genres WHERE id = ?').get(parentId)) {
    return res.status(400).json({ error: 'parent genre not found' });
  }
  // Reuse an existing entry with the same name in the same parent scope.
  const existing = db.prepare(
    'SELECT * FROM genres WHERE name = ? COLLATE NOCASE AND ifnull(parent_id, 0) = ifnull(?, 0)',
  ).get(name, parentId);
  if (existing) {
    if (req.body.definition && !existing.definition) {
      db.prepare("UPDATE genres SET definition = ?, updated_at = datetime('now') WHERE id = ?")
        .run(req.body.definition, existing.id);
    }
    return res.status(200).json(db.prepare('SELECT * FROM genres WHERE id = ?').get(existing.id));
  }
  const info = db.prepare('INSERT INTO genres (name, definition, parent_id) VALUES (?, ?, ?)')
    .run(name, req.body.definition || '', parentId);
  res.status(201).json(db.prepare('SELECT * FROM genres WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/api/genres/:id', (req, res) => {
  const id = Number(req.params.id);
  const genre = db.prepare('SELECT * FROM genres WHERE id = ?').get(id);
  if (!genre) return res.status(404).json({ error: 'Not found' });
  const name = req.body.name !== undefined ? (req.body.name || '').trim() : genre.name;
  if (!name) return res.status(400).json({ error: 'name cannot be empty' });
  const definition = req.body.definition !== undefined ? req.body.definition : genre.definition;

  let parentId = genre.parent_id;
  if (req.body.parent_id !== undefined) {
    parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
    if (parentId != null) {
      if (parentId === id) return res.status(400).json({ error: 'a genre cannot be its own parent' });
      if (!db.prepare('SELECT id FROM genres WHERE id = ?').get(parentId)) {
        return res.status(400).json({ error: 'parent genre not found' });
      }
      // Walk up from the proposed parent; reaching this genre would form a cycle.
      let cur = parentId;
      while (cur != null) {
        if (cur === id) return res.status(400).json({ error: 'cannot move a genre under one of its own descendants' });
        cur = db.prepare('SELECT parent_id FROM genres WHERE id = ?').get(cur)?.parent_id ?? null;
      }
    }
  }

  try {
    db.prepare("UPDATE genres SET name = ?, definition = ?, parent_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, definition, parentId, id);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: 'a genre with that name already exists under that parent' });
    throw err;
  }
  res.json(db.prepare('SELECT * FROM genres WHERE id = ?').get(id));
});

router.delete('/api/genres/:id', (req, res) => {
  // Children cascade (ON DELETE CASCADE); book_genres links cascade too.
  const info = db.prepare('DELETE FROM genres WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// ISBN lookup — merges Open Library and Google Books (see lookup.js).
// ---------------------------------------------------------------------------
router.get('/api/lookup/:isbn', async (req, res) => {
  const isbn = req.params.isbn.replace(/[^0-9Xx]/g, '');
  if (!isbn) return res.status(400).json({ error: 'invalid isbn' });

  try {
    const data = await lookupIsbn(isbn);
    if (!data) return res.status(404).json({ error: 'No metadata found for this ISBN' });
    res.json(data);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return res.status(503).json({
        error: 'Google Books is rate-limited right now (no API key set). Try again later, '
          + 'or set GOOGLE_BOOKS_API_KEY. This book may just not be in Open Library.',
      });
    }
    console.error('lookup failed', err);
    res.status(502).json({ error: 'Lookup service failed' });
  }
});

// ---------------------------------------------------------------------------
// EPUB import — parse an uploaded .epub (metadata + cover) into a book record.
// Body is the raw EPUB; optional query: shelf_id, status.
// ---------------------------------------------------------------------------
router.post('/api/import/epub', express.raw({ type: () => true, limit: '80mb' }), async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty request body' });
  let meta;
  try {
    meta = parseEpub(req.body);
  } catch (err) {
    return res.status(422).json({ error: `Could not parse EPUB: ${err.message}` });
  }
  if (!meta.title) return res.status(422).json({ error: 'EPUB has no title' });

  let coverUrl = '';
  if (meta.cover) {
    try {
      const jpeg = await sharp(meta.cover.data).resize({ width: 500, withoutEnlargement: true })
        .jpeg({ quality: 82 }).toBuffer();
      coverUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    } catch { /* unreadable cover image — import without one */ }
  }

  const data = pick({
    title: meta.title,
    authors: meta.authors,
    isbn: meta.isbn,
    publisher: meta.publisher,
    published_date: meta.published_date,
    cover_url: coverUrl,
    format: 'ebook',
    status: req.query.status || 'tbr',
    source: 'epub',
    shelf_id: req.query.shelf_id || null,
  }, BOOK_COLS);
  const id = insert('books', data);
  res.status(201).json(db.prepare('SELECT * FROM books WHERE id = ?').get(id));
});

app.use(BASE || '/', router);

app.listen(PORT, () => console.log(`📚 Home Library on http://localhost:${PORT}${BASE}/`));
