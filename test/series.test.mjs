// Series + series_books: find-or-create, ordering, and insert-bumps-existing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}/library`;
const DB_PATH = `/tmp/home-library-series-${process.pid}.db`;
let server;

const api = async (path, opts) => {
  const r = await fetch(BASE + '/api' + path, opts);
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const send = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const order = (books) => books.map((b) => `${b.order}:${b.title}`);

test.before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), BASE_PATH: '/library', DB_PATH },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(BASE + '/api/series')).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(() => {
  if (server) server.kill('SIGKILL');
  for (const ext of ['', '-shm', '-wal']) { try { rmSync(DB_PATH + ext, { force: true }); } catch { /* ignore */ } }
});

async function makeSeriesWith(titles) {
  const s = (await api('/series', send('POST', { title: `S${Date.now()}${Math.random()}` }))).body;
  const ids = [];
  for (const [i, t] of titles.entries()) {
    const b = (await api('/books', send('POST', { title: t }))).body;
    ids.push(b.id);
    await api(`/series/${s.id}/books`, send('POST', { book_id: b.id, order: i + 1 }));
  }
  return { series: s, ids };
}

test('creates a series and reuses it case-insensitively', async () => {
  const a = await api('/series', send('POST', { title: 'Dungeon Crawler Carl' }));
  assert.equal(a.status, 201);
  const b = await api('/series', send('POST', { title: 'dungeon crawler carl' }));
  assert.equal(b.status, 200, 'existing series reused, not duplicated');
  assert.equal(b.body.id, a.body.id);
});

test('books come back in series order', async () => {
  const { series } = await makeSeriesWith(['One', 'Two', 'Three']);
  const { body } = await api(`/series/${series.id}/books`);
  assert.deepEqual(order(body), ['1:One', '2:Two', '3:Three']);
});

test('inserting at an occupied order bumps that book and everything after it', async () => {
  const { series } = await makeSeriesWith(['One', 'Two', 'Three']);
  const nb = (await api('/books', send('POST', { title: 'Inserted' }))).body;
  await api(`/series/${series.id}/books`, send('POST', { book_id: nb.id, order: 2 }));
  const { body } = await api(`/series/${series.id}/books`);
  assert.deepEqual(order(body), ['1:One', '2:Inserted', '3:Two', '4:Three']);
});

test('an order beyond the end appends without leaving gaps', async () => {
  const { series } = await makeSeriesWith(['One', 'Two']);
  const nb = (await api('/books', send('POST', { title: 'Far' }))).body;
  await api(`/series/${series.id}/books`, send('POST', { book_id: nb.id, order: 99 }));
  const { body } = await api(`/series/${series.id}/books`);
  assert.deepEqual(order(body), ['1:One', '2:Two', '3:Far']);
});

test('re-placing an existing member moves it without duplicating', async () => {
  const { series, ids } = await makeSeriesWith(['One', 'Two', 'Three']);
  await api(`/series/${series.id}/books`, send('POST', { book_id: ids[2], order: 1 })); // Three -> 1
  const { body } = await api(`/series/${series.id}/books`);
  assert.deepEqual(order(body), ['1:Three', '2:One', '3:Two']);
  assert.equal(body.length, 3, 'no duplicate row for the moved book');
});

test('removing a book closes the gap in ordering', async () => {
  const { series, ids } = await makeSeriesWith(['One', 'Two', 'Three']);
  const del = await api(`/series/${series.id}/books/${ids[0]}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const { body } = await api(`/series/${series.id}/books`);
  assert.deepEqual(order(body), ['1:Two', '2:Three']);
});

test('rejects a non-positive order and an unknown book', async () => {
  const { series, ids } = await makeSeriesWith(['One']);
  assert.equal((await api(`/series/${series.id}/books`, send('POST', { book_id: ids[0], order: 0 }))).status, 400);
  assert.equal((await api(`/series/${series.id}/books`, send('POST', { book_id: 999999, order: 1 }))).status, 400);
});

test('a book carries its series on the books API', async () => {
  const { series, ids } = await makeSeriesWith(['Solo']);
  const { body } = await api(`/books/${ids[0]}`);
  assert.equal(body.series.title, series.title);
  assert.equal(body.series.order, 1);
});
