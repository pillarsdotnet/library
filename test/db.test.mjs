// Regression test for the schema migration: adding the `source` column must not
// disturb databases created before it existed (your live library has real rows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

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
