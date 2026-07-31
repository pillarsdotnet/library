// Regression tests for the edition/copy split.
//
// The migration fans the flat `books` table out into `editions` (what the ISBN
// determines, shared by every copy) and `copies` (one physical object). Both
// halves of that are easy to get wrong in ways that lose data silently, so the
// tests below run the real migration against realistic pre-split databases and
// check what came out the other side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DB_JS = fileURLToPath(new URL('../db.js', import.meta.url));

// Run db.js against a database file in a fresh process, exactly as a restart would.
const migrate = (dbPath) =>
  execFileSync('node', ['-e', `await import(${JSON.stringify(DB_JS)})`], { env: { ...process.env, DB_PATH: dbPath } });

// A pre-split database, with the full flat schema as it stood before the split.
function legacyDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lib-split-'));
  const dbPath = join(dir, 'library.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE shelves (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, bookcase TEXT, label TEXT NOT NULL,
      height_mm INTEGER, width_mm INTEGER, depth_mm INTEGER, notes TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      isbn TEXT, title TEXT NOT NULL, authors TEXT, publisher TEXT, published_date TEXT,
      page_count INTEGER, cover_url TEXT,
      format TEXT DEFAULT 'paperback', jacket TEXT DEFAULT 'na',
      height_mm INTEGER, width_mm INTEGER, thickness_mm INTEGER,
      shelf_id INTEGER REFERENCES shelves(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'tbr', loaned_to TEXT,
      is_library_book INTEGER DEFAULT 0, library_name TEXT, due_date TEXT,
      source TEXT, notes TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      genres_migrated INTEGER DEFAULT 0, cover_source TEXT);
    CREATE TABLE genres (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, definition TEXT,
      parent_id INTEGER REFERENCES genres(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE book_genres (
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
      PRIMARY KEY (book_id, genre_id));
    CREATE TABLE series (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE series_books (
      series INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      "order" INTEGER NOT NULL,
      book INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      PRIMARY KEY (series, book, "order"));
    CREATE TABLE ol_contributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      olid TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT,
      created_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT);
    CREATE UNIQUE INDEX idx_ol_contrib_book_field ON ol_contributions(book_id, field);
    CREATE TABLE lookup_cache (
      isbn TEXT PRIMARY KEY, found INTEGER NOT NULL, data TEXT,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  return { dir, dbPath, db };
}

const addBook = (db, b) => {
  const cols = Object.keys(b);
  return db.prepare(`INSERT INTO books (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
    .run(b).lastInsertRowid;
};

// ─── the collision this whole design exists to prevent ──────────────────────────

test('two copies entered as ISBN-10 and ISBN-13 collapse onto ONE edition', () => {
  const { dir, dbPath, db } = legacyDb();
  // The same book, catalogued twice, years apart, from two different barcodes.
  addBook(db, { isbn: '0441013597', title: 'Dune', authors: 'Frank Herbert', jacket: 'present', status: 'read' });
  addBook(db, { isbn: '978-0-441-01359-3', title: 'Dune', authors: 'Frank Herbert', jacket: 'missing', status: 'tbr' });
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const editions = after.prepare('SELECT * FROM editions').all();
  assert.equal(editions.length, 1, 'one ISBN means one edition, whichever way it was spelled');
  assert.equal(editions[0].isbn13, '9780441013593', 'stored in the canonical 13-digit form');

  const copies = after.prepare('SELECT * FROM copies ORDER BY id').all();
  assert.equal(copies.length, 2, 'both physical copies survive');
  assert.deepEqual(copies.map((c) => c.edition_id), [editions[0].id, editions[0].id]);
  // The per-copy facts stay per-copy.
  assert.deepEqual(copies.map((c) => c.jacket), ['present', 'missing']);
  assert.deepEqual(copies.map((c) => c.status), ['read', 'tbr']);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an ISBN that fails its check digit is never merged', () => {
  const { dir, dbPath, db } = legacyDb();
  // Two different books that a careless normaliser might fuse: same length,
  // same shape, both invalid. Merging on an unverifiable value would overwrite
  // one book's metadata with the other's.
  addBook(db, { isbn: '9780441013594', title: 'Typo One' });
  addBook(db, { isbn: '9780441013594', title: 'Typo Two' });
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM editions').get().n, 2, 'unverifiable ISBNs each get their own edition');
  const titles = after.prepare('SELECT title FROM editions ORDER BY title').all().map((r) => r.title);
  assert.deepEqual(titles, ['Typo One', 'Typo Two'], 'neither title was lost');
  // The value the user typed is kept for display, just never used for matching.
  const texts = after.prepare('SELECT isbn_text FROM editions').all().map((r) => r.isbn_text);
  assert.deepEqual(texts, ['9780441013594', '9780441013594']);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM editions WHERE isbn13 IS NOT NULL').get().n, 0);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('books with no ISBN each get their own edition', () => {
  const { dir, dbPath, db } = legacyDb();
  addBook(db, { title: 'Hand-bound Journal' });
  addBook(db, { title: 'Another Journal' });
  addBook(db, { isbn: '', title: 'Empty ISBN' });
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM editions').get().n, 3, 'NULL is not a join key');
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM copies').get().n, 3);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── the backfill grouping ──────────────────────────────────────────────────────

test('backfill: shared metadata lands on the edition, per-copy facts on the copy', () => {
  const { dir, dbPath, db } = legacyDb();
  db.prepare("INSERT INTO shelves (label) VALUES ('A')").run();
  db.prepare("INSERT INTO shelves (label) VALUES ('B')").run();

  addBook(db, {
    isbn: '9780596000271', title: 'The Cathedral and the Bazaar', authors: 'Eric S. Raymond',
    publisher: "O'Reilly", published_date: '2001', page_count: 241, format: 'paperback',
    height_mm: 233, width_mm: 155, thickness_mm: 18, source: 'openlibrary',
    jacket: 'na', shelf_id: 1, status: 'read', notes: 'my reading copy',
  });
  addBook(db, {
    isbn: '0596000278', title: 'The Cathedral and the Bazaar', authors: 'Eric S. Raymond',
    jacket: 'present', shelf_id: 2, status: 'loaned', loaned_to: 'Dana',
    notes: 'the lending copy', is_library_book: 0,
  });
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const eds = after.prepare('SELECT * FROM editions').all();
  assert.equal(eds.length, 1);
  const e = eds[0];
  // Edition-level: everything the ISBN settles, including format and dimensions.
  assert.equal(e.publisher, "O'Reilly");
  assert.equal(e.page_count, 241);
  assert.deepEqual([e.height_mm, e.width_mm, e.thickness_mm], [233, 155, 18]);
  assert.equal(e.format, 'paperback');
  assert.equal(e.source, 'openlibrary');

  // Copy-level: the four things that genuinely differ between two copies.
  const copies = after.prepare('SELECT * FROM copies ORDER BY id').all();
  assert.deepEqual(copies.map((c) => c.jacket), ['na', 'present']);
  assert.deepEqual(copies.map((c) => c.shelf_id), [1, 2]);
  assert.deepEqual(copies.map((c) => c.status), ['read', 'loaned']);
  assert.deepEqual(copies.map((c) => c.notes), ['my reading copy', 'the lending copy']);
  assert.equal(copies[1].loaned_to, 'Dana');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('backfill: a merging copy fills blanks on the edition but never overwrites', () => {
  const { dir, dbPath, db } = legacyDb();
  // The first copy was catalogued by hand and is missing the publisher; the
  // second came from a lookup and has it. Neither should lose data.
  addBook(db, { isbn: '9780441013593', title: 'Dune', authors: 'Frank Herbert', publisher: null, page_count: null });
  addBook(db, { isbn: '0441013597', title: 'Dune', authors: 'F. Herbert (typo)', publisher: 'Ace', page_count: 412 });
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const e = after.prepare('SELECT * FROM editions').get();
  assert.equal(e.publisher, 'Ace', 'the blank was filled from the second copy');
  assert.equal(e.page_count, 412, 'so was this one');
  assert.equal(e.authors, 'Frank Herbert', 'but a value already present was NOT overwritten');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('backfill: copy ids are preserved, so existing /api/books/:id links keep working', () => {
  const { dir, dbPath, db } = legacyDb();
  addBook(db, { title: 'First' });
  addBook(db, { title: 'Second' });
  const thirdId = addBook(db, { title: 'Third' });
  db.prepare('DELETE FROM books WHERE title = ?').run('Second');   // a gap in the ids
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const ids = after.prepare('SELECT id FROM copies ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, [1, 3], 'ids carried over verbatim, gap and all');
  assert.equal(after.prepare('SELECT title FROM books WHERE id = ?').get(thirdId).title, 'Third');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('backfill: a photographed cover stays with its copy, stock artwork goes to the edition', () => {
  const { dir, dbPath, db } = legacyDb();
  const photo = 'data:image/jpeg;base64,AAAA';
  addBook(db, { isbn: '9780441013593', title: 'Dune', cover_url: 'https://covers.example/dune.jpg' });
  addBook(db, { isbn: '0441013597', title: 'Dune', cover_url: photo, cover_source: 'data:image/jpeg;base64,BBBB' });
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const e = after.prepare('SELECT * FROM editions').get();
  assert.equal(e.cover_url, 'https://covers.example/dune.jpg', 'fetched artwork is edition-level');
  const copies = after.prepare('SELECT * FROM copies ORDER BY id').all();
  assert.equal(copies[0].cover_url, null, 'the copy with no photo of its own has none');
  assert.equal(copies[1].cover_url, photo, "a photograph belongs to the copy that was photographed");
  assert.equal(copies[1].cover_source, 'data:image/jpeg;base64,BBBB', 'and so does its uncropped original');

  // Through the view, a copy's own photo wins over the edition's artwork.
  const view = after.prepare('SELECT id, cover_url FROM books ORDER BY id').all();
  assert.equal(view[0].cover_url, 'https://covers.example/dune.jpg');
  assert.equal(view[1].cover_url, photo);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── everything that pointed at a book id ───────────────────────────────────────

test('genres from merged copies are unioned onto the shared edition', () => {
  const { dir, dbPath, db } = legacyDb();
  db.prepare("INSERT INTO genres (id, name) VALUES (1, 'Science Fiction')").run();
  db.prepare("INSERT INTO genres (id, name) VALUES (2, 'Classics')").run();
  const a = addBook(db, { isbn: '9780441013593', title: 'Dune' });
  const b = addBook(db, { isbn: '0441013597', title: 'Dune' });
  db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run(a, 1);
  db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run(b, 2);
  db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run(b, 1); // overlaps a
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const e = after.prepare('SELECT id FROM editions').get();
  const gids = after.prepare('SELECT genre_id FROM book_genres WHERE edition_id = ? ORDER BY genre_id')
    .all(e.id).map((r) => r.genre_id);
  assert.deepEqual(gids, [1, 2], 'union of both copies, deduplicated');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('series membership is re-pointed onto the edition and deduplicated', () => {
  const { dir, dbPath, db } = legacyDb();
  db.prepare("INSERT INTO series (id, title) VALUES (1, 'Dune')").run();
  const a = addBook(db, { isbn: '9780441013593', title: 'Dune' });
  const b = addBook(db, { isbn: '0441013597', title: 'Dune' });
  db.prepare('INSERT INTO series_books (series, "order", book) VALUES (1, 1, ?)').run(a);
  db.prepare('INSERT INTO series_books (series, "order", book) VALUES (1, 1, ?)').run(b); // same position
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const rows = after.prepare('SELECT * FROM series_books').all();
  assert.equal(rows.length, 1, 'two copies at the same series position are one entry');
  assert.equal(rows[0].edition, after.prepare('SELECT id FROM editions').get().id);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Open Library proposals collapse per edition, keeping an already-sent one', () => {
  const { dir, dbPath, db } = legacyDb();
  const a = addBook(db, { isbn: '9780441013593', title: 'Dune' });
  const b = addBook(db, { isbn: '0441013597', title: 'Dune' });
  // Both copies proposed the same field. One was already sent to Open Library;
  // re-offering it would propose an edit that has already been made.
  db.prepare("INSERT INTO ol_contributions (book_id, olid, field, value, status) VALUES (?, 'OL1M', 'number_of_pages', '412', 'pending')").run(a);
  db.prepare("INSERT INTO ol_contributions (book_id, olid, field, value, status) VALUES (?, 'OL1M', 'number_of_pages', '412', 'sent')").run(b);
  db.prepare("INSERT INTO ol_contributions (book_id, olid, field, value, status) VALUES (?, 'OL1M', 'physical_format', 'paperback', 'pending')").run(a);
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const rows = after.prepare('SELECT * FROM ol_contributions ORDER BY field').all();
  assert.equal(rows.length, 2, 'one row per (edition, field)');
  const pages = rows.find((r) => r.field === 'number_of_pages');
  assert.equal(pages.status, 'sent', 'the sent proposal won, so it is never re-offered');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the lookup cache is re-keyed onto canonical ISBNs', () => {
  const { dir, dbPath, db } = legacyDb();
  db.prepare("INSERT INTO lookup_cache (isbn, found, data, cached_at) VALUES ('0441013597', 1, '{\"title\":\"Dune\"}', '2026-01-01 00:00:00')").run();
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  // Scanning the 13-digit barcode must hit the entry cached from the 10-digit form.
  const hit = after.prepare('SELECT * FROM lookup_cache WHERE isbn = ?').get('9780441013593');
  assert.ok(hit, 'cache entry re-keyed to the canonical form');
  assert.equal(JSON.parse(hit.data).title, 'Dune');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── shape and safety of the result ─────────────────────────────────────────────

test('the books view still presents every column the API reads', () => {
  const { dir, dbPath, db } = legacyDb();
  addBook(db, {
    isbn: '9780441013593', title: 'Dune', authors: 'Frank Herbert', publisher: 'Ace',
    published_date: '1965', page_count: 412, format: 'hardback', jacket: 'present',
    height_mm: 240, width_mm: 160, thickness_mm: 30, status: 'reading', loaned_to: null,
    is_library_book: 1, library_name: 'County Library', due_date: '2026-08-01',
    source: 'openlibrary', notes: 'a note',
  });
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  const row = after.prepare('SELECT * FROM books').get();
  // library_name is preserved as an alias of copies.borrowed_from, so nothing
  // that reads the API has to change.
  assert.equal(row.library_name, 'County Library');
  assert.equal(row.due_date, '2026-08-01');
  assert.equal(row.is_library_book, 1);
  assert.equal(row.format, 'hardback');
  assert.equal(row.jacket, 'present');
  assert.equal(row.notes, 'a note');
  assert.equal(row.isbn, '9780441013593');
  assert.equal(row.edition_id, after.prepare('SELECT id FROM editions').get().id);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the books view is read-only: writes must name editions or copies', () => {
  const { dir, dbPath, db } = legacyDb();
  addBook(db, { isbn: '9780441013593', title: 'Dune' });
  db.close();
  migrate(dbPath);

  const after = new Database(dbPath);
  // No INSTEAD OF triggers, deliberately: a write through the view would report
  // lastInsertRowid 0 and changes 0, which reads as success while doing nothing
  // useful. Failing loudly is the safer contract.
  assert.throws(() => after.prepare("INSERT INTO books (title) VALUES ('X')").run(), /cannot modify.*view|no such/i);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the migration is idempotent: a second startup changes nothing', () => {
  const { dir, dbPath, db } = legacyDb();
  db.prepare("INSERT INTO genres (id, name) VALUES (1, 'SF')").run();
  const a = addBook(db, { isbn: '0441013597', title: 'Dune', jacket: 'present' });
  addBook(db, { isbn: '9780441013593', title: 'Dune', jacket: 'missing' });
  addBook(db, { title: 'No ISBN' });
  db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, 1)').run(a);
  db.close();

  migrate(dbPath);
  const snap = (p) => {
    const d = new Database(p);
    const out = {
      editions: d.prepare('SELECT * FROM editions ORDER BY id').all(),
      copies: d.prepare('SELECT * FROM copies ORDER BY id').all(),
      genres: d.prepare('SELECT * FROM book_genres ORDER BY edition_id, genre_id').all(),
    };
    d.close();
    return out;
  };
  const before = snap(dbPath);
  migrate(dbPath);   // restart
  migrate(dbPath);   // and again
  assert.deepEqual(snap(dbPath), before, 'restarts must not re-split or duplicate anything');
  rmSync(dir, { recursive: true, force: true });
});

test('the split leaves no dangling foreign keys', () => {
  const { dir, dbPath, db } = legacyDb();
  db.prepare("INSERT INTO shelves (label) VALUES ('A')").run();
  db.prepare("INSERT INTO genres (id, name) VALUES (1, 'SF')").run();
  db.prepare("INSERT INTO series (id, title) VALUES (1, 'Dune')").run();
  const a = addBook(db, { isbn: '0441013597', title: 'Dune', shelf_id: 1 });
  const b = addBook(db, { isbn: '9780441013593', title: 'Dune' });
  db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, 1)').run(b);
  db.prepare('INSERT INTO series_books (series, "order", book) VALUES (1, 1, ?)').run(a);
  db.prepare("INSERT INTO ol_contributions (book_id, olid, field, value) VALUES (?, 'OL1M', 'cover', 'x')").run(b);
  db.close();

  migrate(dbPath);

  const after = new Database(dbPath);
  assert.deepEqual(after.pragma('foreign_key_check'), [], 'no orphaned rows anywhere');
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'books' AND type = 'view'").get().n, 1);
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'books' AND type = 'table'").get().n, 0);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});
