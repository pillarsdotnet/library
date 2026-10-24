// The schema as db.js creates it: seeding rules and declared types. Every test
// here runs against a database db.js itself made — there is no other kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DB_JS = fileURLToPath(new URL('../db.js', import.meta.url));
const load = (dbPath) => execFileSync('node', ['-e', `await import(${JSON.stringify(DB_JS)})`],
  { env: { ...process.env, DB_PATH: dbPath } });

test('genre seed runs once: a curated genres table is NOT re-seeded on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-seed-'));
  const dbPath = join(dir, 'library.db');

  load(dbPath);   // fresh database, seeded
  const db = new Database(dbPath);
  // The person curates: everything but one genre goes.
  db.prepare("DELETE FROM genres WHERE name <> 'Maturity' OR parent_id IS NOT NULL").run();
  const left = db.prepare('SELECT COUNT(*) AS n FROM genres').get().n;
  db.close();
  assert.ok(left >= 1, 'the kept genre survived the curation');

  load(dbPath);   // a restart
  const after = new Database(dbPath);
  const names = after.prepare('SELECT DISTINCT name FROM genres ORDER BY name').all().map((r) => r.name);
  after.close();
  assert.deepEqual(names, ['Maturity'], 'deleted genres stay deleted — no resurrection on restart');
  rmSync(dir, { recursive: true, force: true });
});

test('genre seed DOES populate a brand-new (empty) database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-fresh-'));
  const dbPath = join(dir, 'library.db');
  load(dbPath);
  const fresh = new Database(dbPath);
  const n = fresh.prepare('SELECT COUNT(*) AS n FROM genres').get().n;
  fresh.close();
  assert.ok(n >= 6, `fresh DB should be seeded, got ${n} genres`);
  rmSync(dir, { recursive: true, force: true });
});

test('a new database declares dimension columns as INTEGER and stores them as integers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-int-'));
  const dbPath = join(dir, 'library.db');
  load(dbPath);
  const fresh = new Database(dbPath);
  // Book dimensions are edition data (every copy of one ISBN is the same
  // size), so the declared types live on `editions`; `books` is a view, whose
  // columns carry no declared type at all.
  for (const [table, cols] of [['editions', ['height_mm', 'width_mm', 'thickness_mm']], ['shelves', ['height_mm', 'width_mm', 'depth_mm']]]) {
    const info = fresh.prepare(`PRAGMA table_info(${table})`).all();
    for (const c of cols) assert.equal(info.find((x) => x.name === c).type, 'INTEGER', `${table}.${c} declared INTEGER`);
  }
  // `books` is a read-only view, so this writes to the table that owns the column.
  fresh.prepare('INSERT INTO editions (library_id, title, height_mm) VALUES (1, ?, ?)').run('X', 241);
  assert.equal(fresh.prepare("SELECT typeof(height_mm) AS t FROM editions WHERE title = 'X'").get().t, 'integer');
  fresh.close();
  rmSync(dir, { recursive: true, force: true });
});
