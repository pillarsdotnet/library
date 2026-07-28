// Library-borrowed books, listed by due date. The filter answers "what do I owe the
// library and when", so the ordering is part of the feature, not a detail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}/library`;
const DB_PATH = `/tmp/home-library-due-${process.pid}.db`;
let server;

const api = async (path, opts) => {
  const r = await fetch(BASE + '/api' + path, opts);
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const send = (method, data) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
const titles = (books) => books.map((b) => b.title);

// Dates relative to today, so the overdue test cannot rot into passing or failing
// for the wrong reason as the calendar moves.
const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

test.before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), BASE_PATH: '/library', DB_PATH },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(BASE + '/api/books')).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }

  // Deliberately inserted in an order that is neither alphabetical nor by due date,
  // so a passing result cannot be an accident of insertion order.
  for (const b of [
    { title: 'Zebra Husbandry', is_library_book: 1, due_date: day(3) },
    { title: 'Aardvark Care', is_library_book: 1, due_date: day(10) },
    { title: 'Overdue Tome', is_library_book: 1, due_date: day(-5) },
    { title: 'Undated Loan', is_library_book: 1 },
    { title: 'Owned Paperback' },
    { title: 'Owned With A Date', due_date: day(1) },
  ]) await api('/books', send('POST', b));
});

test.after(() => {
  if (server) server.kill('SIGKILL');
  for (const ext of ['', '-shm', '-wal']) {
    try { rmSync(DB_PATH + ext, { force: true }); } catch { /* ignore */ }
  }
});

test('library filter returns only borrowed books', async () => {
  const { body } = await api('/books?library=1&limit=0');
  assert.deepEqual(
    titles(body).sort(),
    ['Aardvark Care', 'Overdue Tome', 'Undated Loan', 'Zebra Husbandry'],
  );
});

test('an owned book is excluded even when it has a due date', async () => {
  // due_date alone must not qualify a book as borrowed, or a stray date on an owned
  // book would show up as something the library is waiting for.
  const { body } = await api('/books?library=1&limit=0');
  assert.ok(!titles(body).includes('Owned With A Date'));
});

test('borrowed books come back soonest-due first', async () => {
  const { body } = await api('/books?library=1&limit=0');
  assert.deepEqual(titles(body), [
    'Overdue Tome',      // -5 days
    'Zebra Husbandry',   // +3
    'Aardvark Care',     // +10
    'Undated Loan',      // no date, sorts last
  ]);
});

test('an undated borrowing sorts last, not first', async () => {
  // SQLite orders NULL before any value, so the naive ORDER BY due_date would put
  // undated books at the top and bury the urgent ones.
  const { body } = await api('/books?library=1&limit=0');
  assert.equal(titles(body).at(-1), 'Undated Loan');
});

test('overdue filter returns only books past their due date', async () => {
  const { body } = await api('/books?library=overdue&limit=0');
  assert.deepEqual(titles(body), ['Overdue Tome']);
});

test('unfiltered listing is still alphabetical by sort title', async () => {
  // The due-date order must apply only to the library view; the default list is
  // still a catalogue, not a deadline queue.
  const { body } = await api('/books?limit=0');
  const idx = (t) => titles(body).indexOf(t);
  assert.ok(idx('Aardvark Care') < idx('Owned Paperback'));
  assert.ok(idx('Owned Paperback') < idx('Zebra Husbandry'));
});

test('the filter composes with search rather than overriding it', async () => {
  const { body } = await api('/books?library=1&q=Aardvark&limit=0');
  assert.deepEqual(titles(body), ['Aardvark Care']);
});

test('X-Total-Count reflects the filter, so paging is not wrong', async () => {
  const r = await fetch(BASE + '/api/books?library=1&limit=2');
  assert.equal(r.headers.get('X-Total-Count'), '4');
  assert.equal((await r.json()).length, 2);
});
