// Regression test for the schema migration: adding the `source` column must not
// disturb databases created before it existed (your live library has real rows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DB_JS = fileURLToPath(new URL('../db.js', import.meta.url));

test('db.js adds the source column to a pre-existing books table, preserving rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-db-'));
  const dbPath = join(dir, 'library.db');

  // Simulate an OLD database: a books table with data but no `source` column.
  const old = new Database(dbPath);
  old.exec('CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, isbn TEXT, status TEXT, shelf_id INTEGER)');
  old.prepare('INSERT INTO books (title, isbn, status) VALUES (?, ?, ?)').run('Existing Book', '123', 'read');
  old.close();

  // Importing db.js against that file should run the migration.
  process.env.DB_PATH = dbPath;
  const { default: db } = await import('../db.js');

  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  assert.ok(cols.includes('source'), 'source column should be added');

  const row = db.prepare('SELECT title, status, source FROM books WHERE isbn = ?').get('123');
  assert.equal(row.title, 'Existing Book', 'existing row preserved');
  assert.equal(row.status, 'read', 'existing data intact');
  assert.equal(row.source, null, 'existing rows get NULL source');

  db.prepare('INSERT INTO books (title, source) VALUES (?, ?)').run('New Book', 'barnesnoble');
  assert.equal(db.prepare('SELECT source FROM books WHERE title = ?').get('New Book').source, 'barnesnoble');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('genre seed runs once: a non-empty genres table is NOT re-seeded (no resurrection on restart)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-seed-'));
  const dbPath = join(dir, 'library.db');

  // A user-curated, non-empty genres table that intentionally lacks the seed genres.
  const pre = new Database(dbPath);
  pre.exec('CREATE TABLE genres (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, definition TEXT, parent_id INTEGER REFERENCES genres(id) ON DELETE CASCADE, created_at TEXT DEFAULT (datetime(\'now\')), updated_at TEXT DEFAULT (datetime(\'now\')))');
  pre.prepare('INSERT INTO genres (name, definition) VALUES (?, ?)').run('OnlyMine', 'custom');
  pre.close();

  // Simulate a restart: run db.js against the existing DB in a fresh process.
  execFileSync('node', ['-e', `await import(${JSON.stringify(DB_JS)})`], { env: { ...process.env, DB_PATH: dbPath } });

  const after = new Database(dbPath);
  const names = after.prepare('SELECT name FROM genres ORDER BY name').all().map((r) => r.name);
  after.close();
  assert.deepEqual(names, ['OnlyMine'], 'no seed genres were re-added to the non-empty table');
  rmSync(dir, { recursive: true, force: true });
});

test('legacy fractional dimensions are rounded to whole millimetres on startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-dim-'));
  const dbPath = join(dir, 'library.db');

  // An older database whose dimensions came from inch entry (241.3 mm etc).
  const old = new Database(dbPath);
  old.exec('CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, isbn TEXT, status TEXT, shelf_id INTEGER, height_mm REAL, width_mm REAL, thickness_mm REAL)');
  old.exec('CREATE TABLE shelves (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, height_mm REAL, width_mm REAL, depth_mm REAL)');
  old.prepare('INSERT INTO books (title, height_mm, width_mm, thickness_mm) VALUES (?, ?, ?, ?)').run('Frac', 241.3, 158.8, 28.4);
  old.prepare('INSERT INTO books (title, height_mm) VALUES (?, ?)').run('Null dims', null);
  old.prepare('INSERT INTO shelves (label, height_mm, width_mm, depth_mm) VALUES (?, ?, ?, ?)').run('S', 304.8, 914.4, 279.4);
  old.close();

  execFileSync('node', ['-e', `await import(${JSON.stringify(DB_JS)})`], { env: { ...process.env, DB_PATH: dbPath } });

  const after = new Database(dbPath);
  const b = after.prepare('SELECT height_mm, width_mm, thickness_mm FROM books WHERE title = ?').get('Frac');
  assert.deepEqual([b.height_mm, b.width_mm, b.thickness_mm], [241, 159, 28], 'book dimensions rounded');
  // A pre-existing column declared REAL keeps REAL affinity, so the storage
  // class stays 'real' (241.0) — what matters is that the value is whole.
  for (const v of [b.height_mm, b.width_mm, b.thickness_mm]) assert.ok(Number.isInteger(v), `${v} is a whole number`);
  const s = after.prepare('SELECT height_mm, width_mm, depth_mm FROM shelves WHERE label = ?').get('S');
  assert.deepEqual([s.height_mm, s.width_mm, s.depth_mm], [305, 914, 279], 'shelf dimensions rounded');
  assert.equal(after.prepare('SELECT height_mm FROM books WHERE title = ?').get('Null dims').height_mm, null, 'NULLs untouched');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test('genre seed DOES populate a brand-new (empty) database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-fresh-'));
  const dbPath = join(dir, 'library.db');
  execFileSync('node', ['-e', `await import(${JSON.stringify(DB_JS)})`], { env: { ...process.env, DB_PATH: dbPath } });
  const fresh = new Database(dbPath);
  const n = fresh.prepare('SELECT COUNT(*) AS n FROM genres').get().n;
  fresh.close();
  assert.ok(n >= 6, `fresh DB should be seeded, got ${n} genres`);
  rmSync(dir, { recursive: true, force: true });
});

test('a new database declares dimension columns as INTEGER and stores them as integers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-int-'));
  const dbPath = join(dir, 'library.db');
  execFileSync('node', ['-e', `await import(${JSON.stringify(DB_JS)})`], { env: { ...process.env, DB_PATH: dbPath } });
  const fresh = new Database(dbPath);
  for (const [table, cols] of [['books', ['height_mm', 'width_mm', 'thickness_mm']], ['shelves', ['height_mm', 'width_mm', 'depth_mm']]]) {
    const info = fresh.prepare(`PRAGMA table_info(${table})`).all();
    for (const c of cols) assert.equal(info.find((x) => x.name === c).type, 'INTEGER', `${table}.${c} declared INTEGER`);
  }
  fresh.prepare('INSERT INTO books (title, height_mm) VALUES (?, ?)').run('X', 241);
  assert.equal(fresh.prepare("SELECT typeof(height_mm) AS t FROM books WHERE title = 'X'").get().t, 'integer');
  fresh.close();
  rmSync(dir, { recursive: true, force: true });
});
