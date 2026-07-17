import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/library.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// All physical dimensions are stored in millimetres (mm).
db.exec(`
  CREATE TABLE IF NOT EXISTS shelves (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    room            TEXT,
    bookcase        TEXT,
    label           TEXT NOT NULL,     -- e.g. "Shelf 3" / "Top left"
    height_mm       REAL,              -- vertical clearance
    width_mm        REAL,              -- horizontal run available for spines
    depth_mm        REAL,              -- front-to-back depth
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
    height_mm       REAL,              -- upright height
    width_mm        REAL,              -- cover width (depth into the shelf)
    thickness_mm    REAL,              -- spine thickness (run along the shelf)

    -- classification
    genre           TEXT,
    subgenre        TEXT,

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

  CREATE INDEX IF NOT EXISTS idx_books_isbn   ON books(isbn);
  CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
  CREATE INDEX IF NOT EXISTS idx_books_title  ON books(title);
  CREATE INDEX IF NOT EXISTS idx_books_shelf  ON books(shelf_id);
`);

// Migrations for databases created before a column existed. ALTER TABLE ADD
// COLUMN is non-destructive (existing rows get NULL).
const bookColumns = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
if (!bookColumns.includes('source')) {
  db.exec('ALTER TABLE books ADD COLUMN source TEXT');
}

export default db;
