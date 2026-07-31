import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sortTitle } from './sorttitle.js';
import { canonicalIsbn } from './isbn.js';
import { coverToken } from './covers.js';
import { GENRE_SEED } from './genres-seed.js';

const DB_PATH = process.env.DB_PATH || './data/library.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Custom SQL function for alphabetizing titles with a leading article skipped.
db.function('sort_title', { deterministic: true }, (t) => sortTitle(t));

// ─── the edition / copy split ───────────────────────────────────────────────────
// Book data divides in two, and the dividing line is the ISBN:
//
//   editions — everything an ISBN determines, and therefore everything that is
//              identical for every copy anywhere: title, authors, publisher,
//              page count, and the physical facts of the edition (format and
//              dimensions — a hardback and a paperback carry DIFFERENT ISBNs, so
//              format is settled by the edition, not by the copy).
//
//   copies   — everything true of one physical object on one shelf: whether its
//              dust jacket survived, where it lives, reading status, who has it
//              on loan, library-borrowing state, and private notes.
//
// `books` remains as a VIEW joining the two, so existing read queries keep
// working unchanged. Writes are a different matter — see the triggers below.
//
// Genres and series hang off the EDITION, not the copy: two copies of one ISBN
// are one book and must not be tagged twice. They are strictly speaking
// properties of the *work* (Open Library keeps the series tag on OL…W, the work,
// while the rest lives on OL…M, the edition — see ol_contributions below), so
// editions carry `ol_work_id`: promoting genres and series to work level later
// is then a matter of re-pointing two foreign keys, not another table split.
const objectKind = (name) =>
  db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(name)?.type;

// A `books` TABLE means this database predates the split and must be migrated.
// A `books` VIEW means the split has already happened.
const LEGACY_BOOKS = objectKind('books') === 'table';

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

  -- What the ISBN determines. Shared by every copy, in this library and (once
  -- there is more than one) in every other.
  CREATE TABLE IF NOT EXISTS editions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Canonical ISBN-13, the only spelling ever stored, so the 10- and 13-digit
    -- forms of one edition cannot become two rows. NULL when the book has no
    -- usable ISBN — see isbn_text.
    --
    -- Not unique on its own: identity is (isbn13, format). In principle one ISBN
    -- means one format, since a hardback and a paperback are separately numbered
    -- — but e-books have ASINs rather than ISBNs, and importers routinely staple
    -- the print ISBN onto the e-book record. Matching on the ISBN alone then
    -- fuses a Kindle file to a hardback and one of them loses its format, its
    -- dimensions, or both. Agreeing on the ISBN is not enough; they must also
    -- agree on what kind of object they are.
    isbn13          TEXT,
    -- The ISBN as the user typed or scanned it, kept for display and so an
    -- unverifiable value is not silently discarded. Never used for matching:
    -- a failed check digit means we cannot prove two books are the same book.
    isbn_text       TEXT,
    -- Open Library work id (OL…W). Unused today; the anchor for moving genres
    -- and series from edition level to work level without a schema split.
    ol_work_id      TEXT,

    title           TEXT NOT NULL,
    authors         TEXT,              -- comma-separated
    publisher       TEXT,
    published_date  TEXT,
    page_count      INTEGER,

    -- Physical facts of the edition. Fixed by the ISBN: every copy of one ISBN
    -- is the same format and the same size.
    format          TEXT DEFAULT 'paperback',   -- hardback | paperback | ebook | audiobook | other
    height_mm       INTEGER,           -- upright height
    width_mm        INTEGER,           -- cover width (depth into the shelf)
    thickness_mm    INTEGER,           -- spine thickness (run along the shelf)

    -- The edition's cover artwork — a stock image from a metadata source. A
    -- photograph of one particular copy belongs on that copy, not here.
    cover_url       TEXT,

    -- where the metadata came from: openlibrary | googlebooks | barnesnoble |
    -- bookofthemonth | manual (auto-filled from lookup, user-editable)
    source          TEXT,

    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_editions_title ON editions(title);
  -- Edition identity. NULLs never compare equal in SQLite, so every book without
  -- a usable ISBN keeps an edition to itself, which is exactly what we want.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_isbn_format ON editions(isbn13, format);

  -- One physical object on one shelf.
  CREATE TABLE IF NOT EXISTS copies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    edition_id      INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,

    -- Survives on this copy or does not. The one genuinely per-copy field in
    -- the edit form's "Physical" group; the rest of that group is edition data.
    jacket          TEXT DEFAULT 'na',          -- present | missing | na

    -- location: a copy lives on a modelled shelf (or nowhere yet)
    shelf_id        INTEGER REFERENCES shelves(id) ON DELETE SET NULL,

    -- status
    status          TEXT DEFAULT 'tbr',         -- tbr | reading | read | loaned
    loaned_to       TEXT,

    -- borrowed from a public library and currently checked out. borrowed_from
    -- was library_name, renamed because a per-tenant library_id is coming and
    -- two differently-meaning "library" columns in one row is a trap.
    is_library_book INTEGER DEFAULT 0,          -- 0 | 1
    borrowed_from   TEXT,
    due_date        TEXT,

    -- A photograph of THIS copy, overriding the edition's stock artwork when
    -- present. cover_source is the photo as taken, kept beside the cropped
    -- cover so the crop can be redone later — on a computer, where dragging
    -- corners is not a fingertip exercise. Cropping is otherwise destructive:
    -- the pixels outside it are gone for good.
    cover_url       TEXT,
    cover_source    TEXT,
    -- Cache-busting tokens for the two images above, stored rather than derived.
    -- A listing needs the token but not the image; keeping it here is what lets
    -- the list query leave the base64 on disk. See covers.js.
    cover_token     TEXT,
    cover_source_token TEXT,

    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_copies_edition ON copies(edition_id);
  CREATE INDEX IF NOT EXISTS idx_copies_shelf   ON copies(shelf_id);
  CREATE INDEX IF NOT EXISTS idx_copies_status  ON copies(status);

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

  -- Cache of ISBN lookups (the merged result across every metadata source), so a
  -- re-scan, a retry, or a second glance at the same book does not spend another
  -- query against a rate-limited service. A book's metadata barely changes, so
  -- hits are cheap and long-lived; misses are kept only briefly, since a book
  -- absent today may be added to a source tomorrow. A rate-limit is never cached
  -- — it is a transient outage, not an answer about the book.
  --
  -- Keyed on the canonical ISBN-13 for the same reason editions are: otherwise
  -- the 10- and 13-digit spellings of one book each pay for their own lookup.
  CREATE TABLE IF NOT EXISTS lookup_cache (
    isbn       TEXT PRIMARY KEY,
    found      INTEGER NOT NULL,      -- 1 = metadata cached in the data column, 0 = genuinely not found
    data       TEXT,                  -- JSON of the lookup result, NULL when not found
    cached_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// The three tables that key on a book. On a pre-split database they must be
// created (or left) in their legacy shape, because the legacy migrations below
// still write to them by book id; the split then rebuilds all three onto
// editions. A fresh database skips straight to the post-split shape.
//
// Genres and series hang off the EDITION: two copies of one ISBN are one book
// and must not be tagged twice. Contributions key on the edition too — the
// proposal edits Open Library's record for that ISBN, so two copies of one book
// must not queue the same edit twice.
db.exec(LEGACY_BOOKS ? `
  CREATE TABLE IF NOT EXISTS series_books (
    series   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    "order"  INTEGER NOT NULL,
    book     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    PRIMARY KEY (series, book, "order")
  );
  CREATE TABLE IF NOT EXISTS book_genres (
    book_id   INTEGER NOT NULL REFERENCES books(id)  ON DELETE CASCADE,
    genre_id  INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, genre_id)
  );
  CREATE TABLE IF NOT EXISTS ol_contributions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    olid        TEXT NOT NULL,
    field       TEXT NOT NULL,
    value       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    error       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ol_contrib_book_field
    ON ol_contributions(book_id, field);
` : `
  -- An edition's position within a series. "order" is a SQL keyword, hence quoted.
  -- One row per position: an omnibus collecting books 1-5 has five rows, so the
  -- position stays an integer and ordering/filtering keep working.
  CREATE TABLE IF NOT EXISTS series_books (
    series   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    "order"  INTEGER NOT NULL,
    edition  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    PRIMARY KEY (series, edition, "order")
  );
  CREATE INDEX IF NOT EXISTS idx_series_books_edition ON series_books(edition);
  CREATE INDEX IF NOT EXISTS idx_series_books_order   ON series_books(series, "order");

  -- Many-to-many: an edition has a set of genres (SQLite has no array column type).
  CREATE TABLE IF NOT EXISTS book_genres (
    edition_id  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    genre_id    INTEGER NOT NULL REFERENCES genres(id)   ON DELETE CASCADE,
    PRIMARY KEY (edition_id, genre_id)
  );
  CREATE INDEX IF NOT EXISTS idx_book_genres_genre ON book_genres(genre_id);

  -- Proposed contributions back to Open Library, one row per field per edition.
  -- Nothing here has been sent: a row is a suggestion waiting for a human, and
  -- only ever suggests filling a blank (see openlibrary.js). Rows are kept
  -- after sending so the same gap is not offered twice.
  CREATE TABLE IF NOT EXISTS ol_contributions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    edition_id  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    -- the record this would edit: an edition (OL123M) for most fields, the work
    -- (OL123W) for the series tag, which Open Library keeps on the work.
    olid        TEXT NOT NULL,
    field       TEXT NOT NULL,          -- cover | physical_dimensions | physical_format | number_of_pages | series
    value       TEXT NOT NULL,          -- what we would send, as it would be sent
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | declined | failed
    error       TEXT,                   -- why a send failed, for the reviewer
    created_at  TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT
  );
  -- One live proposal per edition per field: re-scanning must not stack up
  -- duplicates, and a field already sent is never offered again.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ol_contrib_edition_field
    ON ol_contributions(edition_id, field);
  CREATE INDEX IF NOT EXISTS idx_ol_contrib_status ON ol_contributions(status);
`);

// ─── legacy migrations, run only against a pre-split `books` table ──────────────
// These all predate the edition/copy split and operate on the flat table. Once
// the split has happened `books` is a view and none of them apply.
if (LEGACY_BOOKS) {
  // Migrations for databases created before a column existed. ALTER TABLE ADD
  // COLUMN is non-destructive (existing rows get NULL).
  const bookColumns = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (!bookColumns.includes('source')) {
    db.exec('ALTER TABLE books ADD COLUMN source TEXT');
  }
  if (!bookColumns.includes('genres_migrated')) {
    db.exec('ALTER TABLE books ADD COLUMN genres_migrated INTEGER DEFAULT 0');
  }
  if (!bookColumns.includes('cover_source')) {
    db.exec('ALTER TABLE books ADD COLUMN cover_source TEXT');
  }

  // One-time backfill: turn each book's legacy free-text genre/subgenre into
  // book_genres rows, resolving names to genre ids (creating any missing genres).
  // The old genre-vs-subgenre distinction disambiguates: genre tokens map to
  // top-level genres, subgenre tokens to children.
  //
  // Runs against the pre-split book_genres, whose key column is still book_id;
  // the split below re-points those rows onto editions.
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
        `);
      });
      rebuild();
    }
  }
}

// ─── the split itself ───────────────────────────────────────────────────────────
// Fan the flat `books` table out into editions + copies, re-point everything
// that referenced a book id, and leave `books` behind as a view.
//
// Copy ids are the old book ids, deliberately: the frontend, any bookmarked
// URL and every /api/books/:id path keep working, and the join-table remapping
// stays unambiguous.
if (LEGACY_BOOKS) {
  // Foreign keys off for the duration: three tables still reference books(id)
  // and have to be rebuilt onto editions(id) before books can be dropped. The
  // pragma is a no-op inside a transaction, so it is toggled outside one.
  db.pragma('foreign_keys = OFF');

  const EDITION_FIELDS = [
    'title', 'authors', 'publisher', 'published_date', 'page_count',
    'format', 'height_mm', 'width_mm', 'thickness_mm', 'source',
  ];

  const split = db.transaction(() => {
    const rows = db.prepare('SELECT * FROM books ORDER BY id').all();

    const insEdition = db.prepare(`
      INSERT INTO editions (isbn13, isbn_text, title, authors, publisher, published_date,
                            page_count, format, height_mm, width_mm, thickness_mm,
                            cover_url, source, created_at, updated_at)
      VALUES (@isbn13, @isbn_text, @title, @authors, @publisher, @published_date,
              @page_count, @format, @height_mm, @width_mm, @thickness_mm,
              @cover_url, @source, @created_at, @updated_at)`);
    const insCopy = db.prepare(`
      INSERT INTO copies (id, edition_id, jacket, shelf_id, status, loaned_to,
                          is_library_book, borrowed_from, due_date,
                          cover_url, cover_source, notes, created_at, updated_at)
      VALUES (@id, @edition_id, @jacket, @shelf_id, @status, @loaned_to,
              @is_library_book, @borrowed_from, @due_date,
              @cover_url, @cover_source, @notes, @created_at, @updated_at)`);
    const getEdition = db.prepare('SELECT * FROM editions WHERE id = ?');

    // Only a verifiable ISBN merges copies onto one edition, and only when they
    // also agree on format. Everything else — no ISBN, one whose check digit
    // fails, or a Kindle record wearing the print ISBN — gets an edition to
    // itself, because merging on an unverified or ambiguous key would fuse two
    // different things and silently rewrite one of them.
    const byIsbn = new Map();
    const key = (canon, format) => `${canon} ${format ?? 'paperback'}`;

    for (const r of rows) {
      const now = "datetime('now')";
      const canon = canonicalIsbn(r.isbn);
      // A photographed cover is a fact about one copy; a fetched URL is the
      // edition's artwork. data: means the user shot it themselves.
      const isPhoto = typeof r.cover_url === 'string' && r.cover_url.startsWith('data:');

      let editionId = canon ? byIsbn.get(key(canon, r.format)) : undefined;
      if (editionId === undefined) {
        editionId = Number(insEdition.run({
          isbn13: canon,
          isbn_text: r.isbn ?? null,
          title: r.title ?? '(untitled)',
          authors: r.authors ?? null,
          publisher: r.publisher ?? null,
          published_date: r.published_date ?? null,
          page_count: r.page_count ?? null,
          format: r.format ?? 'paperback',
          height_mm: r.height_mm ?? null,
          width_mm: r.width_mm ?? null,
          thickness_mm: r.thickness_mm ?? null,
          cover_url: isPhoto ? null : (r.cover_url ?? null),
          source: r.source ?? null,
          created_at: r.created_at ?? db.prepare(`SELECT ${now} AS t`).get().t,
          updated_at: r.updated_at ?? db.prepare(`SELECT ${now} AS t`).get().t,
        }).lastInsertRowid);
        if (canon) byIsbn.set(key(canon, r.format), editionId);
      } else {
        // Merging into an edition that already exists: contribute only what it
        // is still missing. First copy wins on conflicts — overwriting would
        // let the last book imported silently rewrite the shared record.
        const cur = getEdition.get(editionId);
        const fill = {};
        for (const f of EDITION_FIELDS) {
          const have = cur[f];
          const incoming = r[f];
          if ((have === null || have === '') && incoming !== null && incoming !== undefined && incoming !== '') {
            fill[f] = incoming;
          }
        }
        if (!cur.cover_url && !isPhoto && r.cover_url) fill.cover_url = r.cover_url;
        const keys = Object.keys(fill);
        if (keys.length) {
          db.prepare(`UPDATE editions SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
            .run({ ...fill, id: editionId });
        }
      }

      insCopy.run({
        id: r.id,
        edition_id: editionId,
        jacket: r.jacket ?? 'na',
        shelf_id: r.shelf_id ?? null,
        status: r.status ?? 'tbr',
        loaned_to: r.loaned_to ?? null,
        is_library_book: r.is_library_book ?? 0,
        borrowed_from: r.library_name ?? null,
        due_date: r.due_date ?? null,
        cover_url: isPhoto ? r.cover_url : null,
        cover_source: r.cover_source ?? null,
        notes: r.notes ?? null,
        created_at: r.created_at ?? db.prepare("SELECT datetime('now') AS t").get().t,
        updated_at: r.updated_at ?? db.prepare("SELECT datetime('now') AS t").get().t,
      });
    }

    // ── re-point the three tables that keyed on a book id ──
    // Each maps book id → edition id through the copies just written. Where two
    // copies merged onto one edition their rows collapse; the primary keys make
    // that automatic, so OR IGNORE is the dedupe.

    db.exec(`
      CREATE TABLE book_genres_new (
        edition_id  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
        genre_id    INTEGER NOT NULL REFERENCES genres(id)   ON DELETE CASCADE,
        PRIMARY KEY (edition_id, genre_id)
      );
      INSERT OR IGNORE INTO book_genres_new (edition_id, genre_id)
        SELECT c.edition_id, bg.genre_id
        FROM book_genres bg JOIN copies c ON c.id = bg.book_id;
      DROP TABLE book_genres;
      ALTER TABLE book_genres_new RENAME TO book_genres;
      CREATE INDEX IF NOT EXISTS idx_book_genres_genre ON book_genres(genre_id);

      CREATE TABLE series_books_new (
        series   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
        "order"  INTEGER NOT NULL,
        edition  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
        PRIMARY KEY (series, edition, "order")
      );
      INSERT OR IGNORE INTO series_books_new (series, "order", edition)
        SELECT sb.series, sb."order", c.edition_id
        FROM series_books sb JOIN copies c ON c.id = sb.book;
      DROP TABLE series_books;
      ALTER TABLE series_books_new RENAME TO series_books;
      CREATE INDEX IF NOT EXISTS idx_series_books_edition ON series_books(edition);
      CREATE INDEX IF NOT EXISTS idx_series_books_order   ON series_books(series, "order");
    `);

    // Contributions collapse per (edition, field). Where merged copies both
    // proposed the same field, keep the one furthest along — an already-sent
    // edit must not be re-offered, which is exactly what the unique index is
    // for. Hence the ORDER BY: 'sent' first, then oldest.
    db.exec(`
      CREATE TABLE ol_contributions_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        edition_id  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
        olid        TEXT NOT NULL,
        field       TEXT NOT NULL,
        value       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT,
        created_at  TEXT DEFAULT (datetime('now')),
        reviewed_at TEXT
      );
      CREATE UNIQUE INDEX idx_ol_contrib_edition_field_new
        ON ol_contributions_new(edition_id, field);
      INSERT OR IGNORE INTO ol_contributions_new
        (id, edition_id, olid, field, value, status, error, created_at, reviewed_at)
        SELECT oc.id, c.edition_id, oc.olid, oc.field, oc.value, oc.status,
               oc.error, oc.created_at, oc.reviewed_at
        FROM ol_contributions oc JOIN copies c ON c.id = oc.book_id
        ORDER BY (oc.status = 'sent') DESC, oc.id;
      DROP TABLE ol_contributions;
      ALTER TABLE ol_contributions_new RENAME TO ol_contributions;
      DROP INDEX IF EXISTS idx_ol_contrib_edition_field_new;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ol_contrib_edition_field
        ON ol_contributions(edition_id, field);
      CREATE INDEX IF NOT EXISTS idx_ol_contrib_status ON ol_contributions(status);
    `);

    // Re-key the lookup cache onto canonical ISBNs, so entries written under the
    // 10-digit spelling are still found when the same book is scanned as 13.
    // Collisions keep the freshest entry.
    const cached = db.prepare('SELECT * FROM lookup_cache').all();
    db.exec('DELETE FROM lookup_cache');
    const insCache = db.prepare(`INSERT INTO lookup_cache (isbn, found, data, cached_at)
      VALUES (@isbn, @found, @data, @cached_at)
      ON CONFLICT(isbn) DO UPDATE SET found = excluded.found, data = excluded.data,
        cached_at = excluded.cached_at WHERE excluded.cached_at > lookup_cache.cached_at`);
    for (const c of cached) {
      insCache.run({ ...c, isbn: canonicalIsbn(c.isbn) || c.isbn });
    }

    db.exec('DROP TABLE books');
  });

  split();

  const violations = db.pragma('foreign_key_check');
  db.pragma('foreign_keys = ON');
  if (violations.length) {
    throw new Error(`edition/copy split left ${violations.length} foreign key violation(s): ` +
      JSON.stringify(violations.slice(0, 5)));
  }
}

// Cover tokens for databases created before they existed, and for rows the split
// above just wrote. Backfilled once; from then on the write paths maintain them.
{
  const copyCols = db.prepare('PRAGMA table_info(copies)').all().map((c) => c.name);
  if (!copyCols.includes('cover_token')) db.exec('ALTER TABLE copies ADD COLUMN cover_token TEXT');
  if (!copyCols.includes('cover_source_token')) db.exec('ALTER TABLE copies ADD COLUMN cover_source_token TEXT');

  const pending = db.prepare(`SELECT id, cover_url, cover_source FROM copies
    WHERE (cover_url IS NOT NULL AND cover_url <> '' AND cover_token IS NULL)
       OR (cover_source IS NOT NULL AND cover_source <> '' AND cover_source_token IS NULL)`).all();
  if (pending.length) {
    const setTokens = db.prepare('UPDATE copies SET cover_token = @t, cover_source_token = @st WHERE id = @id');
    const fill = db.transaction(() => {
      for (const r of pending) {
        setTokens.run({
          id: r.id,
          t: r.cover_url ? coverToken(r.cover_url) : null,
          st: r.cover_source ? coverToken(r.cover_source) : null,
        });
      }
    });
    fill();
  }
}

// ─── the `books` compatibility view ─────────────────────────────────────────────
// Reads keep working exactly as before: one row per copy, edition columns folded
// in. `library_name` is preserved as an alias so existing queries and API
// responses are unchanged even though the column is now `borrowed_from`.
//
// A copy's own photograph wins over the edition's stock artwork.
// Recreated rather than left alone when its shape is out of date: a view is
// derived, so dropping one loses nothing, and a stale definition would silently
// deprive the list query of the columns that keep the images off the read path.
if (objectKind('books') === 'view'
    && !db.prepare('PRAGMA table_info(books)').all().some((c) => c.name === 'cover_token')) {
  db.exec('DROP VIEW books');
}
if (objectKind('books') !== 'view') {
  db.exec(`
    CREATE VIEW books AS
    SELECT
      c.id                              AS id,
      c.edition_id                      AS edition_id,
      COALESCE(e.isbn13, e.isbn_text)   AS isbn,
      e.isbn13                          AS isbn13,
      e.ol_work_id                      AS ol_work_id,
      e.title                           AS title,
      e.authors                         AS authors,
      e.publisher                       AS publisher,
      e.published_date                  AS published_date,
      e.page_count                      AS page_count,
      e.format                          AS format,
      e.height_mm                       AS height_mm,
      e.width_mm                        AS width_mm,
      e.thickness_mm                    AS thickness_mm,
      e.source                          AS source,
      COALESCE(c.cover_url, e.cover_url) AS cover_url,
      c.cover_source                    AS cover_source,
      -- The three small columns a listing needs INSTEAD of the two big ones. A
      -- copy's own photograph is identified by its token; when it has none, the
      -- edition's stock artwork is a short URL that costs nothing to carry.
      c.cover_token                     AS cover_token,
      c.cover_source_token              AS cover_source_token,
      e.cover_url                       AS edition_cover_url,
      c.jacket                          AS jacket,
      c.shelf_id                        AS shelf_id,
      c.status                          AS status,
      c.loaned_to                       AS loaned_to,
      c.is_library_book                 AS is_library_book,
      c.borrowed_from                   AS library_name,
      c.due_date                        AS due_date,
      c.notes                           AS notes,
      c.created_at                      AS created_at,
      c.updated_at                      AS updated_at
    FROM copies c JOIN editions e ON e.id = c.edition_id;
  `);
}

// `books` is READ-ONLY. Writes go to editions and copies directly.
//
// It is deliberately left without INSTEAD OF triggers. Two reasons, both
// discovered rather than assumed:
//
//  1. SQLite reports lastInsertRowid = 0 and changes = 0 for every write through
//     a view — trigger-internal changes are not counted in the outer statement.
//     server.js needs both (the new id to attach genres, the change count to
//     tell a real delete from a 404), so it must write to the tables regardless.
//  2. Resolving which edition an incoming ISBN belongs to needs check-digit
//     arithmetic. In a trigger that means an application-defined SQL function,
//     which exists only on the connection that registered it — so any OTHER
//     connection (the sqlite3 CLI, a backup or restore script, the failover
//     checkpoint) would fail on a write that looked perfectly ordinary.
//
// A read-only view is the honest contract: every existing SELECT keeps working,
// and there is exactly one write path, in JavaScript, where canonicalIsbn() is
// available and a merge can report what it did.

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

// Dimensions are whole millimetres. Round any legacy fractional values (they
// came from inch entry, e.g. 241.3). Idempotent: a no-op once everything is
// integral, so it costs nothing on later startups. Book dimensions now live on
// the edition, which is where the rounding applies.
{
  const roundCols = [['editions', ['height_mm', 'width_mm', 'thickness_mm']], ['shelves', ['height_mm', 'width_mm', 'depth_mm']]];
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
