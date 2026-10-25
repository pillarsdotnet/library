import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sortAuthor, sortTitle } from './sorttitle.js';
import { GENRE_SEED } from './genres-seed.js';

const DB_PATH = process.env.DB_PATH || './data/library.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Custom SQL functions for filing books: titles alphabetized with a leading
// article skipped, authors by the primary author's surname.
db.function('sort_title', { deterministic: true }, (t) => sortTitle(t));
db.function('sort_author', { deterministic: true }, (a) => sortAuthor(a));

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

db.exec(`
  -- A library is a tenant: its own books, shelves, genres and series. Names are
  -- what people type at sign-in, so they are unique however they are cased.
  CREATE TABLE IF NOT EXISTS libraries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    -- Who created the library: the one member who may manage the others (see
    -- accounts.js). NULL reads as the owner — the first library is the
    -- server's own, nobody's creation.
    founder_id  INTEGER REFERENCES users(id),
    -- The library's own lookup API keys, sealed at rest (see accounts.js);
    -- the founder alone may see or change them.
    google_books_key  TEXT,
    isbndb_key        TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_name ON libraries(name COLLATE NOCASE);

  -- A person, identified by the address Google vouched for. The Open Library
  -- keys are that person's own, encrypted (see accounts.js): sending under them
  -- is sending as them, so they belong to a user rather than to a library.
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    email             TEXT NOT NULL,
    ol_access_key     TEXT,
    ol_secret_key     TEXT,
    ol_verified_at    TEXT,
    created_at        TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);

  -- Who may use which library. Checked on every request, so deleting a row
  -- ends that person's access on their next click.
  CREATE TABLE IF NOT EXISTS library_users (
    library_id  INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (library_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_library_users_user ON library_users(user_id);

  CREATE TABLE IF NOT EXISTS shelves (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id      INTEGER REFERENCES libraries(id),
    room            TEXT,
    bookcase        TEXT,
    label           TEXT NOT NULL,     -- free text: "Shelf 3" / "Horror" / a branch name
    -- Where the shelf sits in its bookcase's grid, as a spreadsheet-style
    -- coordinate: column letter + row number, "A1" the top left. Separate from
    -- the label on purpose — the label says what is ON the shelf, the cell says
    -- WHERE it is.
    cell            TEXT,
    -- The bookcase's colour (#rrggbb), NULL meaning the default white. On each
    -- shelf rather than in a bookcases table, because a bookcase IS only the
    -- shelves sharing a room and a name: a colour here follows the bookcase
    -- through every move, merge and copy with no bookkeeping of its own.
    bookcase_color  TEXT,
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
    library_id      INTEGER REFERENCES libraries(id),
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
    format          TEXT DEFAULT 'paperback',   -- hardback | paperback | stapled | ebook | audiobook | other
    height_mm       INTEGER,           -- upright height
    width_mm        INTEGER,           -- cover width (depth into the shelf)
    thickness_mm    INTEGER,           -- spine thickness (run along the shelf)

    -- The edition's cover artwork — a stock image from a metadata source. A
    -- photograph of one particular copy belongs on that copy, not here.
    cover_url       TEXT,

    -- When this edition was last compared against Open Library. Without it the
    -- Give-back sweep could only order by what changed recently, re-reading
    -- the same 25 books however often it runs; "least recently checked" makes
    -- repeated sweeps walk the whole library instead.
    ol_checked_at   TEXT,

    -- where the metadata came from: openlibrary | googlebooks | loc |
    -- barnesnoble | bookofthemonth | manual (auto-filled from lookup,
    -- user-editable)
    source          TEXT,

    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_editions_title ON editions(title);
  -- Edition identity, (library_id, isbn13, format), is indexed in the tenancy
  -- block below, beside the other per-library uniqueness rules.

  -- One physical object on one shelf.
  CREATE TABLE IF NOT EXISTS copies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id      INTEGER REFERENCES libraries(id),
    edition_id      INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,

    -- Survives on this copy or does not. The one genuinely per-copy field in
    -- the edit form's "Physical" group; the rest of that group is edition data.
    jacket          TEXT DEFAULT 'na',          -- present | missing | na

    -- location: a copy lives on a modelled shelf (or nowhere yet)
    shelf_id        INTEGER REFERENCES shelves(id) ON DELETE SET NULL,

    -- Who the copy is physically lent to: a fact about the object, so it stays
    -- here even though the 'loaned' status that usually accompanies it is each
    -- member's own (see user_statuses below).
    loaned_to       TEXT,

    -- borrowed from a public library and currently checked out. borrowed_from
    -- was library_name, renamed because a per-tenant library_id is coming and
    -- two differently-meaning "library" columns in one row is a trap.
    is_library_book INTEGER DEFAULT 0,          -- 0 | 1
    borrowed_from   TEXT,
    due_date        TEXT,

    -- A photograph of THIS copy, overriding the edition's stock artwork when
    -- present. cover_source_file is the photo as taken, kept beside the cropped
    -- cover so the crop can be redone later — on a computer, where dragging
    -- corners is not a fingertip exercise. Cropping is otherwise destructive:
    -- the pixels outside it are gone for good.
    --
    -- Filenames under the covers directory beside this database, never the image
    -- bytes: as data-URLs these were about half the file, and every backup,
    -- handoff and hourly sync carried them. The token is a hash of the bytes, so
    -- a listing can build a cache-busting URL without opening the image. See
    -- covers.js.
    cover_file      TEXT,
    cover_source_file TEXT,
    cover_token     TEXT,
    cover_source_token TEXT,

    notes           TEXT,

    -- Cached spine typography for the visual shelf view, computed in the
    -- browser the first time the spine is drawn: the font size at a scale of
    -- one pixel per millimetre (the view multiplies by its own scale, so one
    -- cache serves a phone and a desktop alike) and the title cell's share of
    -- the spine's length. NULL means "fit it again": the server clears both
    -- whenever an input changes — the title, the authors, the book's
    -- dimensions, which shelf the copy sits on, or that shelf's dimensions.
    spine_font      REAL,
    spine_split     REAL,

    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_copies_edition ON copies(edition_id);
  CREATE INDEX IF NOT EXISTS idx_copies_shelf   ON copies(shelf_id);

  -- Where each USER stands with each copy: tbr | reading | read | loaned |
  -- wishlist. Status is personal, not the copy's — a book one member has read
  -- is still to-be-read for the next — so the row is keyed by both, and a
  -- member with no row simply has not touched the book: they read as 'tbr'.
  -- User 0 is the anonymous user of a server running without sign-in.
  --
  -- A 'wishlist' row is a wish, and the purchase made against it lives on the
  -- same row: somebody visiting the wisher's public page records their address
  -- and the date they chose (see wishlist.js), and both are kept from the
  -- wisher until that date has passed — a gift is a surprise (hidePurchases in
  -- server.js). Both clear whenever the status changes: off the list means no
  -- longer wanted, and back on it is a fresh wish, buyable again.
  CREATE TABLE IF NOT EXISTS user_statuses (
    user_id       INTEGER NOT NULL,
    copy_id       INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'tbr',
    purchased_by  TEXT,
    purchase_date TEXT,
    PRIMARY KEY (user_id, copy_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_statuses_copy ON user_statuses(copy_id);

  CREATE TABLE IF NOT EXISTS genres (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id  INTEGER REFERENCES libraries(id),
    name        TEXT NOT NULL,
    definition  TEXT,
    -- NULL = top-level genre; otherwise this row is a subgenre of parent_id.
    parent_id   INTEGER REFERENCES genres(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  -- Genre and series names are unique per library; indexed in the tenancy block.

  CREATE TABLE IF NOT EXISTS series (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id  INTEGER REFERENCES libraries(id),
    title       TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

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

// The three tables that key on a book, which means on the EDITION: two copies
// of one ISBN are one book and must not be tagged twice. Contributions key on
// the edition too — the proposal edits Open Library's record for that ISBN, so
// two copies of one book must not queue the same edit twice.
db.exec(`
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
  -- Every send that did not go through, kept as what the other end actually
  -- said rather than as a status code. A contribution row holds only its most
  -- recent error, so the pattern across attempts — which statuses, from the
  -- catalogue or from the front end in front of it, on which fields — is not
  -- visible anywhere else. That pattern is how a 403 that resolves on a retry
  -- was told apart from one that never will.
  CREATE TABLE IF NOT EXISTS ol_send_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contribution_id INTEGER REFERENCES ol_contributions(id) ON DELETE CASCADE,
    olid        TEXT,
    field       TEXT,
    status      INTEGER,    -- HTTP status, or NULL when no reply arrived at all
    detail      TEXT,       -- the first 500 characters of what came back
    message     TEXT,       -- what the reviewer was told
    at          TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ol_send_attempts_at ON ol_send_attempts(at);

  CREATE TABLE IF NOT EXISTS ol_contributions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id  INTEGER REFERENCES libraries(id),
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

// ─── libraries: one database, many tenants ──────────────────────────────────────
// Every row a library owns carries its library_id: shelves, editions, copies,
// genres, series and Open Library proposals. The link tables (book_genres,
// series_books, ol_send_attempts) belong to a library through the rows they
// link, and the triggers below keep those links inside one library.
//
// The first library is created here, on an empty database, and the addresses
// in allowed-emails.txt become its members at the same moment; the file is not
// read again.
export const TENANT_TABLES = ['shelves', 'editions', 'copies', 'genres', 'series', 'ol_contributions'];
export const FIRST_LIBRARY_NAME = 'Bobbalisa';
// The server's owner: user 1, the first account this database ever held. A
// member of every library, and the one told when a new library is created.
export const OWNER_ID = 1;

// Beside the database unless AUTH_ALLOWED_FILE points elsewhere.
function allowlist() {
  const path = process.env.AUTH_ALLOWED_FILE || join(dirname(DB_PATH), 'allowed-emails.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n')
    .map((line) => line.replace(/#.*$/, '').trim().toLowerCase())
    .filter(Boolean);
}

{
  // The first library, created once on an empty database. The addresses from
  // allowed-emails.txt beside the database (or AUTH_ALLOWED_FILE) become its
  // members at the same moment, and the file is not read again.
  const bootstrap = db.transaction(() => {
    if (db.prepare('SELECT id FROM libraries ORDER BY id LIMIT 1').get()) return;
    const id = db.prepare('INSERT INTO libraries (name) VALUES (?)').run(FIRST_LIBRARY_NAME).lastInsertRowid;
    const addUser = db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)');
    const userId = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE');
    const link = db.prepare('INSERT OR IGNORE INTO library_users (library_id, user_id) VALUES (?, ?)');
    const emails = allowlist();
    for (const email of emails) {
      addUser.run(email);
      link.run(id, userId.get(email).id);
    }
    if (emails.length) console.log(`👥 ${emails.length} address(es) from allowed-emails.txt are now members of ${FIRST_LIBRARY_NAME}`);
  });
  bootstrap();

  db.exec(`
    -- Identity and uniqueness are per library: two libraries may each own the
    -- same ISBN, or each have a genre called Fantasy.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_library_isbn_format ON editions(library_id, isbn13, format);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_genres_library_name_parent
      ON genres(library_id, name COLLATE NOCASE, ifnull(parent_id, 0));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_series_library_title ON series(library_id, title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_shelves_library ON shelves(library_id);
    CREATE INDEX IF NOT EXISTS idx_copies_library ON copies(library_id);
    CREATE INDEX IF NOT EXISTS idx_ol_contrib_library ON ol_contributions(library_id);
  `);

  // The database refuses what the application must never do, so a query that
  // forgets its library fails loudly instead of quietly mixing two libraries.
  // A row must name its library, may never move to another, and may only point
  // at rows of its own library.
  const trigger = (name, when, event, table, cond) => db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${name} ${when} ${event} ON ${table} FOR EACH ROW
    WHEN ${cond} BEGIN SELECT RAISE(ABORT, '${name}'); END;`);
  for (const t of TENANT_TABLES) {
    trigger(`${t}_library_required`, 'BEFORE', 'INSERT', t, 'NEW.library_id IS NULL');
    trigger(`${t}_library_fixed`, 'BEFORE', 'UPDATE OF library_id', t, 'NEW.library_id IS NOT OLD.library_id');
  }
  const copyCond = `(SELECT library_id FROM editions WHERE id = NEW.edition_id) IS NOT NEW.library_id
    OR (NEW.shelf_id IS NOT NULL AND (SELECT library_id FROM shelves WHERE id = NEW.shelf_id) IS NOT NEW.library_id)`;
  trigger('copies_same_library_ins', 'BEFORE', 'INSERT', 'copies', copyCond);
  trigger('copies_same_library_upd', 'BEFORE', 'UPDATE OF edition_id, shelf_id', 'copies', copyCond);
  const parentCond = `NEW.parent_id IS NOT NULL AND (SELECT library_id FROM genres WHERE id = NEW.parent_id) IS NOT NEW.library_id`;
  trigger('genres_same_library_ins', 'BEFORE', 'INSERT', 'genres', parentCond);
  trigger('genres_same_library_upd', 'BEFORE', 'UPDATE OF parent_id', 'genres', parentCond);
  trigger('book_genres_same_library', 'BEFORE', 'INSERT', 'book_genres',
    '(SELECT library_id FROM genres WHERE id = NEW.genre_id) IS NOT (SELECT library_id FROM editions WHERE id = NEW.edition_id)');
  trigger('series_books_same_library', 'BEFORE', 'INSERT', 'series_books',
    '(SELECT library_id FROM series WHERE id = NEW.series) IS NOT (SELECT library_id FROM editions WHERE id = NEW.edition)');
  trigger('ol_contributions_same_library', 'BEFORE', 'INSERT', 'ol_contributions',
    '(SELECT library_id FROM editions WHERE id = NEW.edition_id) IS NOT NEW.library_id');

  // The owner, user 1, is a member of every library: of each new one as it is
  // created, of every existing one when that user first appears, and of any
  // that predate this rule, below. In the database rather than in createLibrary
  // so that no way of making a library can leave the owner out of it.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS libraries_owner_joins AFTER INSERT ON libraries FOR EACH ROW
    WHEN EXISTS (SELECT 1 FROM users WHERE id = ${OWNER_ID})
    BEGIN INSERT OR IGNORE INTO library_users (library_id, user_id) VALUES (NEW.id, ${OWNER_ID}); END;
    CREATE TRIGGER IF NOT EXISTS users_owner_joins AFTER INSERT ON users FOR EACH ROW
    WHEN NEW.id = ${OWNER_ID}
    BEGIN INSERT OR IGNORE INTO library_users (library_id, user_id) SELECT id, NEW.id FROM libraries; END;
  `);
  const joined = db.prepare(`INSERT OR IGNORE INTO library_users (library_id, user_id)
                             SELECT l.id, u.id FROM libraries l, users u WHERE u.id = ?`).run(OWNER_ID).changes;
  if (joined) console.log(`👤 user ${OWNER_ID} is now a member of ${joined} more library(ies)`);
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
if (objectKind('books') === 'view') {
  const viewCols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  // Stale when a column is missing — or still present: status and the wishlist
  // purchase fields are per user now (user_statuses), joined per request in
  // server.js, and a view that still carries the copy's own would shadow them.
  if (!['cover_file', 'library_id', 'spine_font'].every((col) => viewCols.includes(col))
      || viewCols.includes('status')) {
    db.exec('DROP VIEW books');
  }
}
if (objectKind('books') !== 'view') {
  db.exec(`
    CREATE VIEW books AS
    SELECT
      c.id                              AS id,
      c.library_id                      AS library_id,
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
      -- No image bytes here any more: a copy's photograph is a file, named by
      -- cover_file and versioned by cover_token, and a copy without one falls
      -- back to the edition's stock artwork, which was always just a URL.
      c.cover_file                      AS cover_file,
      c.cover_token                     AS cover_token,
      c.cover_source_file               AS cover_source_file,
      c.cover_source_token              AS cover_source_token,
      e.cover_url                       AS edition_cover_url,
      c.jacket                          AS jacket,
      c.shelf_id                        AS shelf_id,
      -- No status here: status is each user's own (user_statuses), and a view
      -- has no way of knowing who is asking. Queries join it per request.
      c.loaned_to                       AS loaned_to,
      c.is_library_book                 AS is_library_book,
      c.borrowed_from                   AS library_name,
      c.due_date                        AS due_date,
      c.notes                           AS notes,
      c.spine_font                      AS spine_font,
      c.spine_split                     AS spine_split,
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

// Seed a library's genre taxonomy ONCE: when the library is created, or here
// for the first library if it has none. The taxonomy is the library's own after
// that: re-seeding on every startup would resurrect genres somebody has
// deliberately deleted (which it did), so seed rows never go into a library
// that already has genres. Not a transaction of its own, so that creating a
// library can include it in one.
export function seedGenres(libraryId) {
  const insGenre = db.prepare('INSERT INTO genres (library_id, name, definition, parent_id) VALUES (?, ?, ?, ?)');
  for (const g of GENRE_SEED) {
    const parentId = insGenre.run(libraryId, g.name, g.definition, null).lastInsertRowid;
    for (const c of g.children || []) insGenre.run(libraryId, c.name, c.definition, parentId);
  }
}
{
  const first = db.prepare('SELECT id FROM libraries ORDER BY id LIMIT 1').get();
  if (!db.prepare('SELECT 1 FROM genres WHERE library_id = ? LIMIT 1').get(first.id)) {
    db.transaction(() => seedGenres(first.id))();
  }
}


export default db;
