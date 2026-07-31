import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import db from './db.js';
import { canonicalIsbn } from './isbn.js';
import { lookupIsbn, RateLimitError } from './lookup.js';
import { parseEpub } from './epub.js';
import {
  fetchEdition, proposalsFor, login, sendField, sendCover,
  haveCredentials, FIELD_LABELS, FIELD_COMMENTS,
  importAllowed, importPayload, sendImport,
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
// Assets carry ?v=<app version>, so a release is a new URL and a phone cannot
// go on running last week's stylesheet. Browsers revalidate index.html but will
// happily serve a cached styles.css without asking, which is how a deployed fix
// can be invisible on the one device that mattered — and indistinguishable from
// the fix not working. See "Changing CSS or JS" in the README: the version has
// to move whenever these files do.
const VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;
const indexHtml = readFileSync(join(__dirname, 'public/index.html'), 'utf8');
// __V__ is the cache-busting query value and is URI-encoded; __VERSION__ is the
// same version for display, left raw so a build-metadata suffix (1.2.3+build)
// reads as itself rather than as %2Bbuild. The two placeholders cannot collide:
// "__VERSION__" does not contain "__V__".
router.get('/', (_req, res) => res.type('html')
  .send(indexHtml.replace('__BASE__', BASE)
    .replaceAll('__V__', encodeURIComponent(VERSION))
    .replaceAll('__VERSION__', VERSION)));

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
// Split along the edition/copy line — see the schema notes in db.js. Everything
// the ISBN settles (including format and dimensions: a hardback and a paperback
// carry different ISBNs) belongs to the edition and is therefore shared by every
// copy. Only these four groups differ between two copies of one book: whether
// the dust jacket survived, where it sits, its reading status, and its notes.
const EDITION_COLS = [
  'title', 'authors', 'publisher', 'published_date', 'page_count',
  'format', 'height_mm', 'width_mm', 'thickness_mm', 'source',
];
const COPY_COLS = [
  'jacket',
  'shelf_id',
  'status', 'loaned_to',
  'is_library_book', 'due_date',
  'notes',
];
// Accepted from clients; `isbn` and the cover fields are routed by hand because
// each needs a decision rather than a column copy.
const BOOK_COLS = [...EDITION_COLS, ...COPY_COLS, 'isbn', 'cover_url', 'cover_source', 'library_name'];
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
//
// A "book" in the API is a COPY joined to its EDITION (the `books` view). The
// view is read-only, so every write below names editions and copies directly:
// SQLite reports lastInsertRowid 0 and changes 0 for writes through a view, and
// both are load-bearing here.
// ---------------------------------------------------------------------------

// Route an incoming body to the two tables that own its fields.
function splitBookData(data) {
  const edition = {};
  const copy = {};
  for (const k of EDITION_COLS) if (data[k] !== undefined) edition[k] = data[k];
  for (const k of COPY_COLS) if (data[k] !== undefined) copy[k] = data[k];
  // Renamed on the way in: `library_name` (which public library it came from)
  // would sit confusingly beside the tenant `library_id` that multi-library adds.
  if (data.library_name !== undefined) copy.borrowed_from = data.library_name;
  // A photograph is a fact about the copy that was photographed; a fetched URL
  // is the edition's artwork, shared by every copy.
  if (data.cover_url !== undefined) {
    if (typeof data.cover_url === 'string' && data.cover_url.startsWith('data:')) copy.cover_url = data.cover_url;
    else edition.cover_url = data.cover_url;
  }
  if (data.cover_source !== undefined) copy.cover_source = data.cover_source;
  return { edition, copy };
}

// Find the edition an ISBN names, or create it.
//
// Only a verifiable ISBN merges copies onto a shared edition, and only when they
// also agree on format. One that fails its check digit gets an edition to
// itself: merging on a value we cannot check would fuse two unrelated books and
// overwrite one book's metadata with the other's. The raw text is kept for
// display either way.
//
// Format is part of the key because e-books have ASINs, not ISBNs, and importers
// staple the print ISBN onto the e-book record. On the ISBN alone a Kindle file
// and a hardback merge, and one of them loses its format and gains the other's
// physical dimensions.
function resolveEdition(editionData, isbnRaw) {
  const canon = canonicalIsbn(isbnRaw);
  if (canon) {
    // Mirrors the column default, so a client that omits format still matches
    // the paperback it means.
    const format = editionData.format ?? 'paperback';
    const found = db.prepare('SELECT * FROM editions WHERE isbn13 = ? AND format = ?').get(canon, format);
    if (found) {
      // Contribute only what the shared record is still missing. This edition
      // may already back somebody else's copy, so filling a blank is welcome
      // but overwriting a value is not ours to do.
      const fill = {};
      for (const [k, v] of Object.entries(editionData)) {
        if ((found[k] === null || found[k] === '') && v !== null && v !== undefined && v !== '') fill[k] = v;
      }
      if (Object.keys(fill).length) update('editions', found.id, fill);
      return found.id;
    }
  }
  return insert('editions', {
    ...editionData,
    format: editionData.format ?? 'paperback',   // explicit, so it matches next time
    isbn13: canon,
    isbn_text: isbnRaw ?? null,
  });
}

// Replace an edition's genres with the given list of genre ids (ignores unknown
// ids). Genres belong to the edition, so this affects every copy of the book —
// which is the point: two copies of one ISBN are one book, tagged once.
function setBookGenres(editionId, genreIds) {
  if (!Array.isArray(genreIds)) return;
  db.prepare('DELETE FROM book_genres WHERE edition_id = ?').run(editionId);
  const link = db.prepare('INSERT OR IGNORE INTO book_genres (edition_id, genre_id) VALUES (?, ?)');
  const known = db.prepare('SELECT id FROM genres WHERE id = ?');
  for (const gid of genreIds) {
    const n = Number(gid);
    if (n && known.get(n)) link.run(editionId, n);
  }
}

// Attach each row's genres (id + name + parent_id) and series position. Both are
// edition-level, so they are looked up by edition_id and land on every copy.
function attachGenres(books) {
  if (!books.length) return books;
  const rows = db.prepare(`
    SELECT bg.edition_id, g.id, g.name, g.parent_id
    FROM book_genres bg JOIN genres g ON g.id = bg.genre_id
    ORDER BY g.name COLLATE NOCASE`).all();
  const byEdition = new Map();
  for (const r of rows) {
    if (!byEdition.has(r.edition_id)) byEdition.set(r.edition_id, []);
    byEdition.get(r.edition_id).push({ id: r.id, name: r.name, parent_id: r.parent_id });
  }
  // An edition may hold several positions (an omnibus), so collect them per edition.
  const seriesRows = db.prepare(`
    SELECT sb.edition, sb.series AS series_id, sb."order" AS "order", s.title
    FROM series_books sb JOIN series s ON s.id = sb.series
    ORDER BY sb."order"`).all();
  const seriesByEdition = new Map();
  for (const r of seriesRows) {
    if (!seriesByEdition.has(r.edition)) seriesByEdition.set(r.edition, { series_id: r.series_id, title: r.title, orders: [] });
    seriesByEdition.get(r.edition).orders.push(r.order);
  }
  for (const v of seriesByEdition.values()) v.order = v.orders[0];   // earliest position
  for (const b of books) {
    b.genres = byEdition.get(b.edition_id) || [];
    b.genre_ids = b.genres.map((g) => g.id);
    b.series = seriesByEdition.get(b.edition_id) || null;
  }
  return books;
}

router.get('/api/books', (req, res) => {
  const { q, status, room, bookcase, genre_id, series_id, format, shelf_id, library } = req.query;
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
    where.push('NOT EXISTS (SELECT 1 FROM book_genres bg WHERE bg.edition_id = b.edition_id)');
  } else if (genre_id) {
    where.push('EXISTS (SELECT 1 FROM book_genres bg WHERE bg.edition_id = b.edition_id AND bg.genre_id = @genre_id)');
    params.genre_id = Number(genre_id);
  }
  if (series_id === 'none') {
    where.push('NOT EXISTS (SELECT 1 FROM series_books sb WHERE sb.edition = b.edition_id)');
  } else if (series_id) {
    where.push('EXISTS (SELECT 1 FROM series_books sb WHERE sb.edition = b.edition_id AND sb.series = @series_id)');
    params.series_id = Number(series_id);
  }
  if (room) { where.push('s.room = @room'); params.room = room; }
  if (bookcase) { where.push('s.bookcase = @bookcase'); params.bookcase = bookcase; }
  if (shelf_id === 'none') where.push('b.shelf_id IS NULL');
  else if (shelf_id) { where.push('b.shelf_id = @shelf_id'); params.shelf_id = shelf_id; }

  // Library-borrowed books, optionally only those already overdue. A borrowed book
  // with no due date still counts as borrowed — it is undated, not un-borrowed, and
  // excluding it would quietly hide the thing this filter exists to surface.
  if (library === 'overdue') {
    // date('now','localtime'), not UTC: "overdue" is a question about the calendar on
    // the wall, and a book due today should not turn red at 8pm because it is already
    // tomorrow in UTC. SQLite reads the process timezone, so the container MUST be
    // given TZ — without it this silently means UTC. The startup log states the
    // timezone in use so a missing TZ is visible rather than quietly wrong.
    where.push("b.is_library_book = 1 AND b.due_date IS NOT NULL AND b.due_date < date('now','localtime')");
  } else if (library) {
    where.push('b.is_library_book = 1');
  }

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
  // Asking for library books is asking about deadlines, so soonest-due first is the
  // only order that answers it — the same reasoning as the series case that follows.
  // Undated borrowings sort LAST: SQLite orders NULL before any value, which would
  // otherwise bury the genuinely urgent books beneath ones with no deadline at all.
  const orderBy = library
    ? 'b.due_date IS NULL, b.due_date, sort_title(b.title)'
    : (series_id && series_id !== 'none')
    ? `(SELECT MIN(sb."order") FROM series_books sb WHERE sb.edition = b.edition_id AND sb.series = @series_id),
       (SELECT MAX(sb."order") FROM series_books sb WHERE sb.edition = b.edition_id AND sb.series = @series_id),
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
  const { edition, copy } = splitBookData(data);
  // One transaction: a copy without its edition, or genres attached to an
  // edition whose copy failed to insert, would both be worse than no book.
  const create = db.transaction(() => {
    const editionId = resolveEdition(edition, data.isbn);
    const id = insert('copies', { ...copy, edition_id: editionId });
    if (req.body.genre_ids !== undefined) setBookGenres(editionId, req.body.genre_ids);
    return id;
  });
  const id = create();
  res.status(201).json(coverRef(attachGenres([db.prepare('SELECT * FROM books WHERE id = ?').get(id)])[0]));
});

router.put('/api/books/:id', (req, res) => {
  const current = db.prepare('SELECT id, edition_id FROM copies WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  // The client may echo back "api/books/:id/cover"; that means "unchanged".
  if (isCoverRef(req.body.cover_url)) delete req.body.cover_url;
  if (isCoverRef(req.body.cover_source)) delete req.body.cover_source;
  const data = pick(req.body, BOOK_COLS);
  const { edition, copy } = splitBookData(data);

  const save = db.transaction(() => {
    let editionId = current.edition_id;
    const curEd = db.prepare('SELECT * FROM editions WHERE id = ?').get(editionId);
    // Editing the ISBN or the format re-identifies the book: the physical copy
    // is the same object, but it is now recorded as a copy of a different
    // edition. It moves rather than dragging the old edition's identity with it
    // — and it carries its metadata across, so a correction does not blank the
    // record. Format counts because it is half of the identity key: without
    // this, correcting one copy's binding would silently rebind every copy, or
    // collide with the edition that already holds that (isbn, format).
    const isbnChanged = data.isbn !== undefined && canonicalIsbn(data.isbn) !== curEd.isbn13;
    const formatChanged = edition.format !== undefined && edition.format !== curEd.format;
    if (isbnChanged || formatChanged) {
      const carried = {};
      for (const k of EDITION_COLS) if (curEd[k] !== null) carried[k] = curEd[k];
      if (curEd.cover_url) carried.cover_url = curEd.cover_url;
      // Keep the ISBN we already had when only the format moved, or the copy
      // would land on a new edition with its ISBN silently dropped.
      const isbn = data.isbn !== undefined ? data.isbn : (curEd.isbn13 ?? curEd.isbn_text);
      editionId = resolveEdition({ ...carried, ...edition }, isbn);
      db.prepare('UPDATE copies SET edition_id = ? WHERE id = ?').run(editionId, current.id);
    } else if (Object.keys(edition).length) {
      // Edition data is shared by every copy, so this edit is visible on all of them.
      update('editions', editionId, edition);
    }
    if (Object.keys(copy).length) update('copies', current.id, copy);
    if (req.body.genre_ids !== undefined) setBookGenres(editionId, req.body.genre_ids);
  });
  save();
  res.json(coverRef(attachGenres([db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id)])[0]));
});

// Deletes the copy. The edition stays: it is shared metadata that another copy
// may still reference, and it costs a row to keep the book re-addable without a
// fresh lookup.
router.delete('/api/books/:id', (req, res) => {
  const info = db.prepare('DELETE FROM copies WHERE id = ?').run(req.params.id);
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
  // Over editions, not copies: the proposal edits Open Library's record for an
  // ISBN, so owning three copies of a book is no reason to scan it three times.
  const books = db.prepare(`
    SELECT e.*, e.id AS edition_id, COALESCE(e.isbn13, e.isbn_text) AS isbn, (
      SELECT s.title FROM series_books sb JOIN series s ON s.id = sb.series
      WHERE sb.edition = e.id ORDER BY sb."order" LIMIT 1
    ) AS series_title,
    (SELECT c.cover_url FROM copies c WHERE c.edition_id = e.id AND c.cover_url IS NOT NULL LIMIT 1) AS copy_cover
    FROM editions e
    -- Any ISBN we hold, not just a verifiable one: an ISBN that fails its check
    -- digit is still worth asking Open Library about, and the answer ("unknown")
    -- is more useful than silently skipping the book.
    WHERE COALESCE(e.isbn13, e.isbn_text) IS NOT NULL AND COALESCE(e.isbn13, e.isbn_text) <> ''
    ORDER BY e.updated_at DESC LIMIT ?`).all(limit);
  const already = db.prepare('SELECT 1 FROM ol_contributions WHERE edition_id = ? AND field = ?');
  const add = db.prepare(`INSERT OR IGNORE INTO ol_contributions (edition_id, olid, field, value)
                          VALUES (?, ?, ?, ?)`);
  let scanned = 0, queued = 0, unknown = 0;
  for (const book of books) {
    // Only a photograph one of our copies actually carries is ours to offer.
    // The edition's own cover_url is stock artwork, quite possibly Open
    // Library's own, and uploading that back to them proposes nothing.
    book.cover_url = book.copy_cover;
    let edition = null;
    try { edition = await fetchEdition(book.isbn); } catch { edition = null; }
    scanned += 1;
    if (!edition) {
      unknown += 1;
      // Open Library has no edition for this ISBN. Adding one is creating a
      // record rather than filling a blank, so it happens only when explicitly
      // switched on — and still only as a proposal.
      if (importAllowed() && !already.get(book.edition_id, 'import') && importPayload(book)) {
        add.run(book.edition_id, 'NEW', 'import', book.isbn);
        queued += 1;
      }
      continue;
    }
    for (const p of proposalsFor(book, edition.record, edition.work)) {
      if (already.get(book.edition_id, p.field)) continue;
      // Each proposal records the record it would edit: the series tag belongs
      // to the work, everything else to the edition.
      add.run(book.edition_id, p.target === 'work' ? edition.workOlid : edition.olid, p.field, p.value);
      queued += 1;
    }
  }
  res.json({ scanned, queued, unknown });
});

router.get('/api/ol-contributions', (req, res) => {
  const status = req.query.status || 'pending';
  // Joined to editions, not to the books view: a book owned in duplicate would
  // otherwise list the same proposal once per copy.
  const rows = db.prepare(`
    SELECT c.*, e.title, e.authors, COALESCE(e.isbn13, e.isbn_text) AS isbn
    FROM ol_contributions c JOIN editions e ON e.id = c.edition_id
    WHERE c.status = ? ORDER BY e.title, c.field`).all(status);
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
  // The sendable cover is a photograph one of our copies carries, never the
  // edition's stock artwork — see the scan above.
  const row = db.prepare(`SELECT c.*,
      (SELECT cp.cover_url FROM copies cp
        WHERE cp.edition_id = c.edition_id AND cp.cover_url IS NOT NULL LIMIT 1) AS cover_url
    FROM ol_contributions c
    WHERE c.id = ? AND c.status IN ('pending', 'failed')`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!haveCredentials()) return res.status(503).json({ error: 'Open Library credentials are not configured' });

  try {
    const cookie = await login();
    if (row.field === 'import') {
      // Any copy of the edition presents the same importable metadata.
      const book = db.prepare('SELECT * FROM books WHERE edition_id = ? LIMIT 1').get(row.edition_id);
      const payload = importPayload(book);
      if (!payload) throw new Error('this book no longer has enough detail to import');
      // Rehearse first: the preview runs Open Library's own duplicate matching,
      // so a book that turns out to already exist is caught before anything is
      // written rather than becoming a duplicate someone has to merge.
      const dry = await sendImport(payload, cookie, { preview: true });
      if (dry?.edition?.status === 'matched') {
        throw new Error(`Open Library already has this book as ${dry.edition.key} — not importing`);
      }
      const done = await sendImport(payload, cookie, { preview: false });
      const created = String(done?.edition?.key || '').split('/').pop() || 'NEW';
      db.prepare(`UPDATE ol_contributions SET status = 'sent', olid = ?, error = NULL,
                  reviewed_at = datetime('now') WHERE id = ?`).run(created, row.id);
      return res.json({ ok: true, olid: created, created: done });
    }
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

// Series membership belongs to the edition, so a series lists one entry per
// volume however many copies of it are owned. The representative copy is the
// lowest-numbered one, which keeps every entry linkable to a real /api/books/:id.
const SERIES_MEMBER_JOIN = `FROM series_books sb
  JOIN books b ON b.id = (SELECT MIN(c.id) FROM copies c WHERE c.edition_id = sb.edition)`;

router.get('/api/series/:id/books', (req, res) => {
  res.json(db.prepare(`
    SELECT sb."order" AS "order", b.*
    ${SERIES_MEMBER_JOIN}
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
  // The API still speaks in book (copy) ids; the position is recorded against
  // the edition, so placing one copy places the book however many copies exist.
  const bookId = Number(req.body.book_id);
  const copy = bookId ? db.prepare('SELECT edition_id FROM copies WHERE id = ?').get(bookId) : null;
  if (!copy) {
    return res.status(400).json({ error: 'valid book_id is required' });
  }
  const orders = parseOrders(req.body.orders ?? req.body.order);
  if (!orders.length) {
    return res.status(400).json({ error: 'order must be a positive integer, list or range (e.g. 3, "1,3" or "1-5")' });
  }

  const place = db.transaction(() => {
    // Re-placing the same book replaces all of its positions in this series.
    db.prepare('DELETE FROM series_books WHERE series = ? AND edition = ?').run(seriesId, copy.edition_id);
    const ins = db.prepare('INSERT INTO series_books (series, "order", edition) VALUES (?, ?, ?)');
    for (const o of orders) ins.run(seriesId, o, copy.edition_id);
  });
  place();
  res.status(201).json(db.prepare(`
    SELECT sb."order" AS "order", b.id, b.title
    ${SERIES_MEMBER_JOIN}
    WHERE sb.series = ? ORDER BY sb."order", sort_title(b.title)`).all(seriesId));
});

// Removing a book leaves the other orders alone: they are the books' numbers in
// the series, not positions in a list (renumbering would be wrong when several
// editions share a number).
router.delete('/api/series/:id/books/:bookId', (req, res) => {
  const copy = db.prepare('SELECT edition_id FROM copies WHERE id = ?').get(req.params.bookId);
  if (!copy) return res.status(404).json({ error: 'Not found' });
  const info = db.prepare('DELETE FROM series_books WHERE series = ? AND edition = ?')
    .run(Number(req.params.id), copy.edition_id);
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
// ISBN lookup — merges Open Library and Google Books (see lookup.js), behind a
// cache so a re-scan or retry does not spend another query on a book already
// answered. Every cached answer — found or not — is kept at least 24 hours;
// found ones longer, since metadata barely changes. `?refresh=1` skips the
// cache to re-fetch on demand.
//
// When a source is rate-limited, stale cache beats no data: rather than fail, a
// throttled lookup falls back to whatever was last cached for the ISBN, however
// old, and only errors when nothing was ever cached. A rate-limit is itself
// never written to the cache — it is an outage, not an answer about the book.
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 3600 * 1000;
// Floor every TTL at 24h so nothing is ever discarded younger than a day.
const LOOKUP_TTL_MS = Math.max(Number(process.env.LOOKUP_TTL_DAYS ?? 30) * DAY_MS, DAY_MS);
const NEGATIVE_TTL_MS = Math.max(Number(process.env.LOOKUP_NEGATIVE_TTL_HOURS ?? 24) * 3600 * 1000, DAY_MS);

const getCachedLookup = db.prepare('SELECT found, data, cached_at FROM lookup_cache WHERE isbn = ?');
const putCachedLookup = db.prepare(`INSERT INTO lookup_cache (isbn, found, data, cached_at)
  VALUES (@isbn, @found, @data, datetime('now'))
  ON CONFLICT(isbn) DO UPDATE SET found = @found, data = @data, cached_at = datetime('now')`);

const cacheAgeMs = (row) => Date.now() - new Date(row.cached_at + 'Z').getTime();
// A cached row is fresh if it is younger than the TTL for its kind.
function freshCachedLookup(isbn) {
  const row = getCachedLookup.get(isbn);
  if (!row) return null;
  const ttlMs = row.found ? LOOKUP_TTL_MS : NEGATIVE_TTL_MS;
  return cacheAgeMs(row) <= ttlMs ? row : null;
}

// Turn a cached row into a response. `state` is the X-Lookup-Cache label.
function serveCached(res, row, state) {
  res.set('X-Lookup-Cache', state);
  if (row.found) return res.json(JSON.parse(row.data));
  return res.status(404).json({ error: 'No metadata found for this ISBN' });
}

router.get('/api/lookup/:isbn', async (req, res) => {
  const isbn = req.params.isbn.replace(/[^0-9Xx]/g, '');
  if (!isbn) return res.status(400).json({ error: 'invalid isbn' });

  if (req.query.refresh !== '1') {
    const fresh = freshCachedLookup(isbn);
    if (fresh) return serveCached(res, fresh, 'hit');
  }

  try {
    const data = await lookupIsbn(isbn);
    // Cache the answer either way — found, or a genuine "no source has it".
    putCachedLookup.run({ isbn, found: data ? 1 : 0, data: data ? JSON.stringify(data) : null });
    res.set('X-Lookup-Cache', 'miss');
    if (!data) return res.status(404).json({ error: 'No metadata found for this ISBN' });
    res.json(data);
  } catch (err) {
    if (err instanceof RateLimitError) {
      // Prefer stale data to no data: whatever was last cached, however old.
      const stale = getCachedLookup.get(isbn);
      if (stale) return serveCached(res, stale, 'stale');
      return res.status(503).json({
        error: 'A metadata source is rate-limited right now, and this ISBN has not been '
          + 'looked up before, so there is nothing cached to fall back on. Try again later.',
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
  const { edition, copy } = splitBookData(data);
  const create = db.transaction(() => {
    const editionId = resolveEdition(edition, data.isbn);
    return insert('copies', { ...copy, edition_id: editionId });
  });
  const id = create();
  res.status(201).json(db.prepare('SELECT * FROM books WHERE id = ?').get(id));
});

app.use(BASE || '/', router);

app.listen(PORT, () => {
  // Due dates are compared against the local civil date, so the timezone is part of
  // the app's behaviour, not just cosmetics. Stating it makes a container running on
  // the default UTC obvious instead of subtly shifting what counts as overdue.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`📚 Home Library on http://localhost:${PORT}${BASE}/`);
  console.log(`   timezone ${tz}${tz === 'UTC' ? ' (set TZ if that is not intended — due dates use it)' : ''}`);
});
