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
