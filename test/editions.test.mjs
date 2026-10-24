// The `books` view: the one read surface over editions + copies. Its shape is
// what the whole API selects from (BOOK_SELECT in server.js), and it must stay
// read-only — a write through a view reports lastInsertRowid 0 and changes 0,
// which reads as success while doing nothing useful.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DB_JS = fileURLToPath(new URL('../db.js', import.meta.url));
const freshDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-view-'));
  const dbPath = join(dir, 'library.db');
  execFileSync('node', ['-e', `await import(${JSON.stringify(DB_JS)})`], { env: { ...process.env, DB_PATH: dbPath } });
  return { dir, dbPath };
};

test('the books view presents every column the API reads', () => {
  const { dir, dbPath } = freshDb();
  const db = new Database(dbPath);
  const ed = db.prepare(`INSERT INTO editions (library_id, isbn13, title, authors, publisher,
      published_date, page_count, format, height_mm, width_mm, thickness_mm, source)
    VALUES (1, '9780441013593', 'Dune', 'Frank Herbert', 'Ace', '1965', 412, 'hardback', 240, 160, 30, 'openlibrary')`)
    .run().lastInsertRowid;
  db.prepare(`INSERT INTO copies (library_id, edition_id, jacket, is_library_book, borrowed_from, due_date, notes)
    VALUES (1, ?, 'present', 1, 'County Library', '2026-08-01', 'a note')`).run(ed);

  const row = db.prepare('SELECT * FROM books').get();
  // library_name is an alias of copies.borrowed_from, so nothing that reads
  // the API has to care where the column lives.
  assert.equal(row.library_name, 'County Library');
  assert.equal(row.due_date, '2026-08-01');
  assert.equal(row.is_library_book, 1);
  assert.equal(row.format, 'hardback');
  assert.equal(row.jacket, 'present');
  assert.equal(row.notes, 'a note');
  assert.equal(row.isbn, '9780441013593');
  assert.equal(row.edition_id, ed);
  // Status is per user (user_statuses), so the view deliberately has no status
  // column for anybody's query to lean on by accident.
  assert.equal('status' in row, false);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the books view is read-only: writes must name editions or copies', () => {
  const { dir, dbPath } = freshDb();
  const db = new Database(dbPath);
  assert.throws(() => db.prepare("INSERT INTO books (title) VALUES ('X')").run(), /cannot modify.*view|no such/i);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
