// How a listing files its books — on a shelf, in a search, anywhere no more
// specific order applies: primary author's surname, given name, series title
// (a standalone book files under its own title), position in the series,
// title with the leading article skipped, then binding (ebook, hardback,
// paperback). Through HTTP, because the order is produced by the one query
// every view reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3277;           // grep `PORT = ` across test/ before picking one
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/home-library-shelf-order-${process.pid}.db`;
const COVERS_DIR = DB_PATH.replace(/\.db$/, '-covers');

let server;

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test.before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH, COVERS_DIR },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/meta`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(() => {
  server?.kill();
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  rmSync(COVERS_DIR, { recursive: true, force: true });
});

test('a listing files by author, series, position, title, then binding', async () => {
  // Entered deliberately out of order, every pair adjacent in the expected
  // result differing by exactly one sort key.
  const add = (b) => api('POST', '/api/books', { format: 'paperback', ...b });
  const books = [
    // Le Guin: the particle belongs to the surname, so she files under L
    // after Herbert, not under G.
    { title: 'The Dispossessed', authors: 'Ursula K. Le Guin' },
    // Asimov: two bindings of one title — ebook before hardback before paperback.
    { title: 'Nightfall', authors: 'Isaac Asimov', format: 'paperback', isbn: '9780553290998' },
    { title: 'Nightfall', authors: 'Isaac Asimov', format: 'hardback', isbn: '9780385249379' },
    { title: 'Nightfall', authors: 'Isaac Asimov', format: 'ebook', isbn: '9780307792396' },
    // Herbert: a standalone title interleaves with the series by its own name.
    { title: 'The Green Brain', authors: 'Frank Herbert' },
    { title: 'Children of Dune', authors: 'Frank Herbert', isbn: '9780441104024' },
    { title: 'Dune Messiah', authors: 'Frank Herbert', isbn: '9780441172696' },
    { title: 'Dune', authors: 'Frank Herbert', isbn: '9780441013593' },
    // Same surname, different given name: Brian files before Frank.
    { title: 'The Ascension Factor', authors: 'Brian Herbert' },
  ];
  const made = {};
  for (const b of books) {
    const r = await add(b);
    assert.equal(r.status, 201);
    made[`${b.title}|${b.format || 'paperback'}`] = r.body.id;
  }

  // The Dune books belong to a series in reading order; "The Green Brain" does not.
  const s = (await api('POST', '/api/series', { title: 'The Dune Chronicles' })).body;
  for (const [title, order] of [['Dune', 1], ['Dune Messiah', 2], ['Children of Dune', 3]]) {
    const r = await api('POST', `/api/series/${s.id}/books`, { book_id: made[`${title}|paperback`], order });
    assert.equal(r.status, 201);
  }

  const { body } = await api('GET', '/api/books?limit=0');
  assert.deepEqual(body.map((b) => `${b.title} (${b.format})`), [
    'Nightfall (ebook)',                // Asimov before Herbert
    'Nightfall (hardback)',             // same book: ebook, hardback, paperback
    'Nightfall (paperback)',
    'The Ascension Factor (paperback)', // Brian Herbert before Frank
    'Dune (paperback)',                 // "The Dune Chronicles" files before "green brain"…
    'Dune Messiah (paperback)',         // …and inside it, reading order beats the alphabet
    'Children of Dune (paperback)',
    'The Green Brain (paperback)',      // standalone, under its own title
    'The Dispossessed (paperback)',     // Le Guin files under L, last of all
  ]);
});
