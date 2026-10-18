// Shelf cells (the grid coordinate within a bookcase), bookcase colors, and
// the one-time backfill that derives both when a database gains the columns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 3241;   // grep `PORT = ` across test/ before picking one: 3233 was the owner test's stub SMTP
const BASE = `http://127.0.0.1:${PORT}/library`;
const DB_PATH = `/tmp/home-library-cells-${process.pid}.db`;
const COVERS_DIR = DB_PATH.replace(/\.db$/, '-covers');
let server;

const api = async (path, opts) => {
  const r = await fetch(BASE + '/api' + path, opts);
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const send = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const shelf = async (data) => (await api('/shelves', send('POST', data))).body;
const allShelves = async () => (await api('/shelves')).body;

async function start() {
  server = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), BASE_PATH: '/library', DB_PATH, COVERS_DIR },
    stdio: 'ignore',
  });
  // Generous: the whole suite runs in parallel, and this file restarts the
  // server twice more while every other file's server is also starting.
  const deadline = Date.now() + 30000;
  for (;;) {
    try { if ((await fetch(BASE + '/api/shelves')).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
}

// SIGKILL leaves no window for the process to write after the test moves on,
// and waiting for the exit event means the database file is free to reopen.
async function stop() {
  if (!server) return;
  const gone = new Promise((r) => server.once('exit', r));
  server.kill('SIGKILL');
  await gone;
  server = null;
}

test.before(start);
test.after(async () => {
  await stop();
  for (const ext of ['', '-shm', '-wal']) { try { rmSync(DB_PATH + ext, { force: true }); } catch { /* ignore */ } }
  rmSync(COVERS_DIR, { recursive: true, force: true });
});

test('a cell is stored uppercased, and blank clears it', async () => {
  const s = await shelf({ room: 'Den', bookcase: 'Oak', label: 'Fiction', cell: 'a1' });
  assert.equal(s.cell, 'A1');
  const r = await api(`/shelves/${s.id}`, send('PUT', { cell: '' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.cell, null);
  await api(`/shelves/${s.id}`, send('PUT', { cell: 'A1' }));   // restore for later tests
});

test('a malformed cell is refused', async () => {
  for (const cell of ['1A', 'A0', 'A-1', 'cellar', 'A 1']) {
    const r = await api('/shelves', send('POST', { room: 'Den', bookcase: 'Oak', label: 'x', cell }));
    assert.equal(r.status, 400, `cell ${JSON.stringify(cell)} should be refused`);
    assert.match(r.body.error, /cell/);
  }
});

test('a cell is unique within its bookcase, not across bookcases', async () => {
  const dup = await api('/shelves', send('POST', { room: 'Den', bookcase: 'Oak', label: 'dup', cell: 'A1' }));
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already used/);

  const elsewhere = await api('/shelves', send('POST', { room: 'Den', bookcase: 'Pine', label: 'ok', cell: 'A1' }));
  assert.equal(elsewhere.status, 201);

  // A shelf keeping its own cell on an edit is not a clash with itself…
  const own = (await allShelves()).find((s) => s.bookcase === 'Oak' && s.cell === 'A1');
  const keep = await api(`/shelves/${own.id}`, send('PUT', { cell: 'A1', notes: 'still me' }));
  assert.equal(keep.status, 200);

  // …but moving a shelf into a bookcase whose A1 is taken is.
  const mover = (await allShelves()).find((s) => s.bookcase === 'Pine');
  const clash = await api(`/shelves/${mover.id}`, send('PUT', { bookcase: 'Oak' }));
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /already used/);
});

test('a bookcase color lands on every shelf of the destination bookcase', async () => {
  await shelf({ room: 'Den', bookcase: 'Oak', label: 'Second', cell: 'A2' });
  const r = await api('/bookcases', send('PUT', { from: { room: 'Den', bookcase: 'Oak' }, room: 'Den', bookcase: 'Oak', color: '#8B4513' }));
  assert.equal(r.status, 200);
  const oaks = (await allShelves()).filter((s) => s.bookcase === 'Oak');
  assert.ok(oaks.length >= 2);
  for (const s of oaks) assert.equal(s.bookcase_color, '#8b4513', 'normalised to lowercase, on every shelf');

  const bad = await api('/bookcases', send('PUT', { from: { room: 'Den', bookcase: 'Oak' }, room: 'Den', bookcase: 'Oak', color: 'mahogany' }));
  assert.equal(bad.status, 400);

  // Merging Pine into Oak repaints the merged whole, so one bookcase cannot
  // wear two colors.
  const merge = await api('/bookcases', send('PUT', { from: { room: 'Den', bookcase: 'Pine' }, room: 'Den', bookcase: 'Oak', color: '#5c3a21' }));
  assert.equal(merge.status, 200);
  for (const s of (await allShelves()).filter((x) => x.bookcase === 'Oak')) assert.equal(s.bookcase_color, '#5c3a21');

  const clear = await api('/bookcases', send('PUT', { from: { room: 'Den', bookcase: 'Oak' }, room: 'Den', bookcase: 'Oak', color: null }));
  assert.equal(clear.status, 200);
  for (const s of (await allShelves()).filter((x) => x.bookcase === 'Oak')) assert.equal(s.bookcase_color, null);
});

test('copying a bookcase carries cells and color', async () => {
  await api('/bookcases', send('PUT', { from: { room: 'Den', bookcase: 'Oak' }, room: 'Den', bookcase: 'Oak', color: '#4e2a14' }));
  const r = await api('/bookcases', send('POST', { from: { room: 'Den', bookcase: 'Oak' }, room: 'Hall', bookcase: 'Oak twin' }));
  assert.equal(r.status, 201);
  const twins = (await allShelves()).filter((s) => s.bookcase === 'Oak twin');
  const originals = (await allShelves()).filter((s) => s.bookcase === 'Oak');
  assert.equal(twins.length, originals.length);
  assert.deepEqual(twins.map((s) => s.cell).sort(), originals.map((s) => s.cell).sort());
  for (const s of twins) assert.equal(s.bookcase_color, '#4e2a14');
});

test('a bookcase can be created as a rows × columns grid', async () => {
  const r = await api('/bookcases', send('POST', { room: 'Attic', bookcase: 'New wall', rows: 2, columns: 3 }));
  assert.equal(r.status, 201);
  assert.equal(r.body.created, 6);
  const made = (await allShelves()).filter((s) => s.bookcase === 'New wall');
  assert.deepEqual(made.map((s) => s.cell).sort(), ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  for (const s of made) assert.equal(s.label, s.cell, 'cell names stand in for labels');

  const again = await api('/bookcases', send('POST', { room: 'Attic', bookcase: 'New wall', rows: 1, columns: 1 }));
  assert.equal(again.status, 409);
  const silly = await api('/bookcases', send('POST', { room: 'Attic', bookcase: 'Too wide', rows: 1, columns: 27 }));
  assert.equal(silly.status, 400);
});

test('meta reports average dimensions per cover type', async () => {
  await api('/books', send('POST', { title: 'HB one', format: 'hardback', height_mm: 200, width_mm: 150, thickness_mm: 30 }));
  await api('/books', send('POST', { title: 'HB two', format: 'hardback', height_mm: 220, width_mm: 150, thickness_mm: 40 }));
  await api('/books', send('POST', { title: 'PB', format: 'paperback', height_mm: 180, width_mm: 110, thickness_mm: 20 }));
  const meta = (await api('/meta')).body;
  assert.deepEqual(meta.avg_dims.hardback, { height_mm: 210, width_mm: 150, thickness_mm: 35 });
  assert.deepEqual(meta.avg_dims.softcover, { height_mm: 180, width_mm: 110, thickness_mm: 20 });
});

test('spine typography is cached on the copy and cleared by the writes that change it', async () => {
  const s1 = await shelf({ room: 'Nook', bookcase: 'Case', label: 'one', cell: 'A1' });
  const s2 = await shelf({ room: 'Nook', bookcase: 'Case', label: 'two', cell: 'A2' });
  const b = (await api('/books', send('POST', { title: 'Spine Book', authors: 'A. Writer', shelf_id: s1.id }))).body;
  const book = async () => (await api('/books/' + b.id)).body;
  const cache = (font, split) => api('/spine-fonts', send('POST', { fonts: { [b.id]: { font, split } } }));

  let r = await cache(3.21, 0.62);
  assert.equal(r.body.saved, 1);
  let got = await book();
  assert.equal(got.spine_font, 3.21);
  assert.equal(got.spine_split, 0.62);

  r = await cache(-1, 2);   // nonsense is ignored, not stored
  assert.equal(r.body.saved, 0);
  assert.equal((await book()).spine_font, 3.21);

  await api('/books/' + b.id, send('PUT', { shelf_id: s2.id }));
  assert.equal((await book()).spine_font, null, 'moving the copy clears it');

  await cache(3, 0.5);
  await api('/shelves/' + s2.id, send('PUT', { height_mm: 280 }));
  assert.equal((await book()).spine_font, null, 'resizing the shelf clears it');

  await cache(3, 0.5);
  await api('/books/' + b.id, send('PUT', { title: 'Spine Book, Revised' }));
  assert.equal((await book()).spine_font, null, 'retitling clears it');

  await cache(3, 0.5);
  await api('/books/' + b.id, send('PUT', { notes: 'just a note' }));
  assert.equal((await book()).spine_font, 3, 'an unrelated edit keeps it');
});

// The one-time label→cell backfill that 5.5.0 carried is gone: the only
// deployment's database was migrated by hand, and a fresh database starts
// with the columns. See CHANGELOG 5.6.0.
