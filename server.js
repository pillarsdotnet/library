import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import db from './db.js';
import { lookupIsbn, RateLimitError } from './lookup.js';
import { parseEpub } from './epub.js';

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
const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Writable columns. Anything else in a request body is ignored.
// ---------------------------------------------------------------------------
const BOOK_COLS = [
  'isbn', 'title', 'authors', 'publisher', 'published_date', 'page_count', 'cover_url',
  'format', 'jacket', 'height_mm', 'width_mm', 'thickness_mm',
  'genre', 'subgenre', 'shelf_id',
  'status', 'loaned_to',
  'is_library_book', 'library_name', 'due_date',
  'source', 'notes',
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
router.get('/api/books', (req, res) => {
  const { q, status, room, bookcase, genre, format, shelf_id } = req.query;
  const where = [];
  const params = {};

  if (q) {
    where.push('(b.title LIKE @q OR b.authors LIKE @q OR b.isbn LIKE @q OR b.genre LIKE @q OR b.subgenre LIKE @q)');
    params.q = `%${q}%`;
  }
  for (const [field, value] of [['status', status], ['format', format]]) {
    if (value) { where.push(`b.${field} = @${field}`); params[field] = value; }
  }
  // genre/subgenre are comma-joined multi-values; match one token exactly by
  // wrapping both the column and the needle in the ", " delimiter.
  for (const [field, value] of [['genre', genre], ['subgenre', req.query.subgenre]]) {
    if (value) {
      where.push(`instr(', ' || b.${field} || ', ', @${field}) > 0`);
      params[field] = `, ${value}, `;
    }
  }
  if (room) { where.push('s.room = @room'); params.room = room; }
  if (bookcase) { where.push('s.bookcase = @bookcase'); params.bookcase = bookcase; }
  if (shelf_id === 'none') where.push('b.shelf_id IS NULL');
  else if (shelf_id) { where.push('b.shelf_id = @shelf_id'); params.shelf_id = shelf_id; }

  const sql = `
    SELECT b.*, s.room, s.bookcase, s.label AS shelf_label
    FROM books b LEFT JOIN shelves s ON s.id = b.shelf_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY sort_title(b.title)`;
  res.json(db.prepare(sql).all(params));
});

router.get('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json(book);
});

router.post('/api/books', (req, res) => {
  const data = pick(req.body, BOOK_COLS);
  if (!data.title) return res.status(400).json({ error: 'title is required' });
  const id = insert('books', data);
  res.status(201).json(db.prepare('SELECT * FROM books WHERE id = ?').get(id));
});

router.put('/api/books/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: 'Not found' });
  update('books', req.params.id, pick(req.body, BOOK_COLS));
  res.json(db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id));
});

router.delete('/api/books/:id', (req, res) => {
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
    genres: distinct('books', 'genre'),
    subgenres: distinct('books', 'subgenre'),
    count: db.prepare('SELECT COUNT(*) AS n FROM books').get().n,
    unshelved: db.prepare('SELECT COUNT(*) AS n FROM books WHERE shelf_id IS NULL').get().n,
  });
});

// ---------------------------------------------------------------------------
// Genres — hierarchical taxonomy (parent_id NULL = top-level, else a subgenre).
// ---------------------------------------------------------------------------
router.get('/api/genres', (_req, res) => {
  res.json(db.prepare('SELECT * FROM genres ORDER BY name COLLATE NOCASE').all());
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
  const genre = db.prepare('SELECT * FROM genres WHERE id = ?').get(req.params.id);
  if (!genre) return res.status(404).json({ error: 'Not found' });
  const name = req.body.name !== undefined ? (req.body.name || '').trim() : genre.name;
  if (!name) return res.status(400).json({ error: 'name cannot be empty' });
  const definition = req.body.definition !== undefined ? req.body.definition : genre.definition;
  db.prepare("UPDATE genres SET name = ?, definition = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, definition, req.params.id);
  res.json(db.prepare('SELECT * FROM genres WHERE id = ?').get(req.params.id));
});

router.delete('/api/genres/:id', (req, res) => {
  // Children cascade (ON DELETE CASCADE); books keep their free-text genre value.
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
