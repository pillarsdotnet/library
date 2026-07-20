import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sortTitle } from './sorttitle.js';
import { GENRE_SEED } from './genres-seed.js';

const DB_PATH = process.env.DB_PATH || './data/library.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Custom SQL function for alphabetizing titles with a leading article skipped.
db.function('sort_title', { deterministic: true }, (t) => sortTitle(t));

// All physical dimensions are stored as whole millimetres (mm).
db.exec(`
  CREATE TABLE IF NOT EXISTS shelves (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    room            TEXT,
    bookcase        TEXT,
    label           TEXT NOT NULL,     -- e.g. "Shelf 3" / "Top left"
    height_mm       INTEGER,           -- vertical clearance
    width_mm        INTEGER,           -- horizontal run available for spines
    depth_mm        INTEGER,           -- front-to-back depth
    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS books (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    isbn            TEXT,
    title           TEXT NOT NULL,
    authors         TEXT,              -- comma-separated
    publisher       TEXT,
    published_date  TEXT,
    page_count      INTEGER,
    cover_url       TEXT,

    -- physical description
    format          TEXT DEFAULT 'paperback',   -- hardback | paperback | ebook | audiobook | other
    jacket          TEXT DEFAULT 'na',          -- present | missing | na
    height_mm       INTEGER,           -- upright height
    width_mm        INTEGER,           -- cover width (depth into the shelf)
    thickness_mm    INTEGER,           -- spine thickness (run along the shelf)

    -- classification: genres are a many-to-many via the book_genres table.

    -- location: a book lives on a modelled shelf (or nowhere yet)
    shelf_id        INTEGER REFERENCES shelves(id) ON DELETE SET NULL,

    -- status
    status          TEXT DEFAULT 'tbr',         -- tbr | reading | read | loaned
    loaned_to       TEXT,

    -- library-borrowed books that are currently checked out
    is_library_book INTEGER DEFAULT 0,          -- 0 | 1
    library_name    TEXT,
    due_date        TEXT,

    -- where the metadata came from: openlibrary | googlebooks | barnesnoble |
    -- bookofthemonth | manual (auto-filled from lookup, user-editable)
    source          TEXT,

    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS genres (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    definition  TEXT,
    -- NULL = top-level genre; otherwise this row is a subgenre of parent_id.
    parent_id   INTEGER REFERENCES genres(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  -- A name is unique within its parent scope (top-level names, and children of a
  -- given parent). The same subgenre name may recur under different parents
  -- (e.g. "Contemporary" under both Fantasy and Realism).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_genres_name_parent
    ON genres(name COLLATE NOCASE, ifnull(parent_id, 0));

  CREATE TABLE IF NOT EXISTS series (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_series_title ON series(title COLLATE NOCASE);

  -- A book's position within a series. "order" is a SQL keyword, hence quoted.
  -- One row per position: an omnibus collecting books 1-5 has five rows, so the
  -- position stays an integer and ordering/filtering keep working.
  CREATE TABLE IF NOT EXISTS series_books (
    series   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    "order"  INTEGER NOT NULL,
    book     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    PRIMARY KEY (series, book, "order")
  );
  CREATE INDEX IF NOT EXISTS idx_series_books_book  ON series_books(book);
  CREATE INDEX IF NOT EXISTS idx_series_books_order ON series_books(series, "order");

  -- Many-to-many: a book has a set of genres (SQLite has no array column type).
  CREATE TABLE IF NOT EXISTS book_genres (
    book_id   INTEGER NOT NULL REFERENCES books(id)  ON DELETE CASCADE,
    genre_id  INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, genre_id)
  );
  CREATE INDEX IF NOT EXISTS idx_book_genres_genre ON book_genres(genre_id);

  CREATE INDEX IF NOT EXISTS idx_books_isbn   ON books(isbn);
  CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
  CREATE INDEX IF NOT EXISTS idx_books_title  ON books(title);
  CREATE INDEX IF NOT EXISTS idx_books_shelf  ON books(shelf_id);
`);

// Seed the genre taxonomy ONCE, only when the table is empty. The taxonomy is
// user-owned after that: re-seeding on every startup would resurrect genres the
// user has deliberately deleted (which it did), so we never re-insert seed rows
// into a non-empty table.
if (db.prepare('SELECT COUNT(*) AS n FROM genres').get().n === 0) {
  const insGenre = db.prepare('INSERT INTO genres (name, definition, parent_id) VALUES (?, ?, ?)');
  const seed = db.transaction(() => {
    for (const g of GENRE_SEED) {
      const parentId = insGenre.run(g.name, g.definition, null).lastInsertRowid;
      for (const c of g.children || []) insGenre.run(c.name, c.definition, parentId);
    }
  });
  seed();
}

// Migrations for databases created before a column existed. ALTER TABLE ADD
// COLUMN is non-destructive (existing rows get NULL).
const bookColumns = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
if (!bookColumns.includes('source')) {
  db.exec('ALTER TABLE books ADD COLUMN source TEXT');
}
if (!bookColumns.includes('genres_migrated')) {
  db.exec('ALTER TABLE books ADD COLUMN genres_migrated INTEGER DEFAULT 0');
}

// One-time backfill: turn each book's legacy free-text genre/subgenre into
// book_genres rows, resolving names to genre ids (creating any missing genres).
// The old genre-vs-subgenre distinction disambiguates: genre tokens map to
// top-level genres, subgenre tokens to children.
if (bookColumns.includes('genre') && bookColumns.includes('subgenre')) {
  const splitTokens = (s) => String(s || '').split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  const findByName = db.prepare('SELECT * FROM genres WHERE name = ? COLLATE NOCASE');
  const findTop = db.prepare('SELECT * FROM genres WHERE name = ? COLLATE NOCASE AND parent_id IS NULL');
  const findChild = db.prepare('SELECT * FROM genres WHERE name = ? COLLATE NOCASE AND parent_id IS NOT NULL');
  const insGenre = db.prepare('INSERT INTO genres (name, definition, parent_id) VALUES (?, ?, ?)');
  const link = db.prepare('INSERT OR IGNORE INTO book_genres (book_id, genre_id) VALUES (?, ?)');
  const markDone = db.prepare('UPDATE books SET genres_migrated = 1 WHERE id = ?');

  const migrate = db.transaction(() => {
    const pending = db.prepare('SELECT id, genre, subgenre FROM books WHERE genres_migrated = 0').all();
    for (const b of pending) {
      const ids = new Set();
      let firstTopId = null;
      for (const name of splitTokens(b.genre)) {
        const g = findTop.get(name) || insGenre.run(name, '', null);
        const id = g.id ?? g.lastInsertRowid;
        firstTopId = firstTopId ?? id;
        ids.add(id);
      }
      for (const name of splitTokens(b.subgenre)) {
        let g = findChild.get(name) || findByName.get(name);
        if (!g) {
          const info = insGenre.run(name, '', firstTopId); // child of the book's genre if any, else top-level
          g = { id: info.lastInsertRowid };
        }
        ids.add(g.id);
      }
      for (const id of ids) link.run(b.id, id);
      markDone.run(b.id);
    }
  });
  migrate();

  // The legacy free-text columns are now fully backfilled into book_genres;
  // drop them (genres live only in the join table + genres taxonomy now).
  db.exec('ALTER TABLE books DROP COLUMN genre');
  db.exec('ALTER TABLE books DROP COLUMN subgenre');
}

// series_books originally keyed on (series, book), which capped a book at one
// position. An omnibus spans several, so rebuild with (series, book, "order").
// Nothing references series_books, so this is a plain copy-and-swap.
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'series_books'").get()?.sql || '';
  if (/PRIMARY KEY\s*\(\s*series\s*,\s*book\s*\)/i.test(sql)) {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE series_books_new (
          series   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
          "order"  INTEGER NOT NULL,
          book     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          PRIMARY KEY (series, book, "order")
        );
        INSERT INTO series_books_new (series, "order", book) SELECT series, "order", book FROM series_books;
        DROP TABLE series_books;
        ALTER TABLE series_books_new RENAME TO series_books;
        CREATE INDEX IF NOT EXISTS idx_series_books_book  ON series_books(book);
        CREATE INDEX IF NOT EXISTS idx_series_books_order ON series_books(series, "order");
      `);
    });
    rebuild();
  }
}

// Dimensions are whole millimetres. Round any legacy fractional values (they
// came from inch entry, e.g. 241.3). Idempotent: a no-op once everything is
// integral, so it costs nothing on later startups.
{
  const roundCols = [['books', ['height_mm', 'width_mm', 'thickness_mm']], ['shelves', ['height_mm', 'width_mm', 'depth_mm']]];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  const roundDims = db.transaction(() => {
    for (const [table, cols] of roundCols) {
      if (!tables.includes(table)) continue;
      const present = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      for (const col of cols) {
        if (!present.includes(col)) continue;
        db.prepare(`UPDATE ${table} SET ${col} = CAST(ROUND(${col}) AS INTEGER)
                    WHERE ${col} IS NOT NULL AND ${col} <> CAST(ROUND(${col}) AS INTEGER)`).run();
      }
    }
  });
  roundDims();
}

export default db;
