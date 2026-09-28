// Moving, renaming and copying a bookcase: every shelf in it follows, and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 3231;
const BASE = `http://127.0.0.1:${PORT}/library`;
const DB_PATH = `/tmp/home-library-bookcases-${process.pid}.db`;
const COVERS_DIR = DB_PATH.replace(/\.db$/, '-covers');
let server;

const api = async (path, opts) => {
  const r = await fetch(BASE + '/api' + path, opts);
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const send = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const shelf = async (room, bookcase, label) =>
  (await api('/shelves', send('POST', { room, bookcase, label }))).body;
const where = async (s) => {
  const { room, bookcase } = (await api(`/shelves/${s.id}`)).body;
  return [room, bookcase];
};

test.before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), BASE_PATH: '/library', DB_PATH, COVERS_DIR },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(BASE + '/api/shelves')).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(() => {
  if (server) server.kill('SIGKILL');
  for (const ext of ['', '-shm', '-wal']) { try { rmSync(DB_PATH + ext, { force: true }); } catch { /* ignore */ } }
  rmSync(COVERS_DIR, { recursive: true, force: true });
});

test('moves every shelf of a bookcase to another room, and no other shelf', async () => {
  const top = await shelf('Den', 'Oak', 'Top');
  const bottom = await shelf('Den', 'Oak', 'Bottom');
  const sameNameOtherRoom = await shelf('Hall', 'Oak', 'Top');
  const otherCase = await shelf('Den', 'Pine', 'Top');
  const book = (await api('/books', send('POST', { title: 'Riding along', shelf_id: top.id }))).body;

  const r = await api('/bookcases', send('PUT', { from: { room: 'Den', bookcase: 'Oak' }, room: 'Study', bookcase: 'Oak tall' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 2);

  assert.deepEqual(await where(top), ['Study', 'Oak tall']);
  assert.deepEqual(await where(bottom), ['Study', 'Oak tall']);
  assert.deepEqual(await where(sameNameOtherRoom), ['Hall', 'Oak'], 'a same-named bookcase elsewhere stays');
  assert.deepEqual(await where(otherCase), ['Den', 'Pine'], 'the rest of the room stays');

  assert.equal((await api(`/books/${book.id}`)).body.shelf_id, top.id, 'books stay on their shelf');
  const inStudy = (await api('/books?room=Study')).body;
  assert.deepEqual(inStudy.map((b) => b.id), [book.id], 'and so move with it');
});

test('a bookcase with no name, or no room, can be named', async () => {
  const loose = await shelf('', null, 'Loose');
  const r = await api('/bookcases', send('PUT', { from: { room: null, bookcase: '' }, room: ' Attic ', bookcase: 'Crate' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await where(loose), ['Attic', 'Crate'], 'trimmed');

  await api('/bookcases', send('PUT', { from: { room: 'Attic', bookcase: 'Crate' }, room: '', bookcase: 'Crate' }));
  assert.deepEqual(await where(loose), [null, 'Crate'], 'a blank room is stored as none');
});

test('an unknown bookcase is not found, and a missing `from` is refused', async () => {
  const none = await api('/bookcases', send('PUT', { from: { room: 'Nowhere', bookcase: 'Nothing' }, room: 'X' }));
  assert.equal(none.status, 404);
  const bad = await api('/bookcases', send('PUT', { room: 'X' }));
  assert.equal(bad.status, 400);
});

test('copies a bookcase\'s shelves, but not its books, to a new place', async () => {
  const top = (await api('/shelves', send('POST', { room: 'Loft', bookcase: 'Birch', label: 'Top', height_mm: 300, width_mm: 800, depth_mm: 250, notes: 'dusty' }))).body;
  const bottom = await shelf('Loft', 'Birch', 'Bottom');
  const book = (await api('/books', send('POST', { title: 'Staying put', shelf_id: top.id }))).body;

  const r = await api('/bookcases', send('POST', { from: { room: 'Loft', bookcase: 'Birch' }, room: 'Cellar', bookcase: 'Birch too' }));
  assert.equal(r.status, 201);
  assert.equal(r.body.copied, 2);

  const all = (await api('/shelves')).body;
  const copies = all.filter((s) => s.room === 'Cellar' && s.bookcase === 'Birch too');
  assert.deepEqual(copies.map((s) => s.label).sort(), ['Bottom', 'Top']);
  const topCopy = copies.find((s) => s.label === 'Top');
  assert.deepEqual(
    [topCopy.height_mm, topCopy.width_mm, topCopy.depth_mm, topCopy.notes],
    [300, 800, 250, 'dusty'], 'dimensions and notes come along');
  assert.ok(copies.every((s) => s.book_count === 0), 'the books do not');

  assert.deepEqual(await where(top), ['Loft', 'Birch'], 'the original stays');
  assert.deepEqual(await where(bottom), ['Loft', 'Birch']);
  assert.equal((await api(`/books/${book.id}`)).body.shelf_id, top.id);
});

test('a copy must be a new bookcase', async () => {
  await shelf('Porch', 'Wicker', 'Only');
  await shelf('Porch', 'Cane', 'Only');
  const count = async () => (await api('/shelves')).body.length;
  const before = await count();
  for (const target of [{ room: 'Porch', bookcase: 'Wicker' }, { room: ' Porch', bookcase: 'Cane ' }]) {
    const r = await api('/bookcases', send('POST', { from: { room: 'Porch', bookcase: 'Wicker' }, ...target }));
    assert.equal(r.status, 409, JSON.stringify(target));
  }
  assert.equal(await count(), before, 'nothing was copied');

  const none = await api('/bookcases', send('POST', { from: { room: 'Nowhere', bookcase: 'Nothing' }, room: 'X' }));
  assert.equal(none.status, 404);
  assert.equal((await api('/bookcases', send('POST', { room: 'X' }))).status, 400);
});
