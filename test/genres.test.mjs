// Genre taxonomy: DB seed + API (create / subgenre / dedupe / edit / delete).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}/library`;
const DB_PATH = `/tmp/home-library-genres-${process.pid}.db`;
let server;

const api = async (path, opts) => {
  const r = await fetch(BASE + '/api' + path, opts);
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const json = (body) => ({ method: body.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body.data) });

test.before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), BASE_PATH: '/library', DB_PATH },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(BASE + '/api/genres')).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(() => {
  if (server) server.kill('SIGKILL');
  for (const ext of ['', '-shm', '-wal']) { try { rmSync(DB_PATH + ext, { force: true }); } catch { /* ignore */ } }
});

test('seeds the taxonomy with the right hierarchy and definitions', async () => {
  const { body } = await api('/genres');
  const top = body.filter((g) => !g.parent_id);
  const names = top.map((g) => g.name).sort();
  assert.deepEqual(names, ['Fantasy', 'Mystery', 'Occupational', 'Realism', 'Science Fiction', 'Thriller']);

  const fantasy = top.find((g) => g.name === 'Fantasy');
  assert.match(fantasy.definition, /supernatural entities, magic/);
  const fantasyKids = body.filter((g) => g.parent_id === fantasy.id).map((g) => g.name).sort();
  assert.deepEqual(fantasyKids, ['Contemporary', 'High', 'Historical']);

  // "Contemporary" exists under both Fantasy and Realism (distinct rows).
  const contemporaries = body.filter((g) => g.name === 'Contemporary');
  assert.equal(contemporaries.length, 2);
});

test('creates a new top-level genre with a definition', async () => {
  const { status, body } = await api('/genres', json({ method: 'POST', data: { name: 'Horror', definition: 'Meant to frighten.' } }));
  assert.equal(status, 201);
  assert.equal(body.name, 'Horror');
  assert.equal(body.parent_id, null);
  assert.equal(body.definition, 'Meant to frighten.');
});

test('creates a subgenre under a parent', async () => {
  const { body: all } = await api('/genres');
  const sf = all.find((g) => g.name === 'Science Fiction');
  const { status, body } = await api('/genres', json({ method: 'POST', data: { name: 'Cyberpunk', definition: 'High tech, low life.', parent_id: sf.id } }));
  assert.equal(status, 201);
  assert.equal(body.parent_id, sf.id);
});

test('creating a duplicate name in the same scope reuses the existing row', async () => {
  const first = await api('/genres', json({ method: 'POST', data: { name: 'Satire', definition: '' } }));
  const again = await api('/genres', json({ method: 'POST', data: { name: 'satire', definition: 'Uses irony to criticize.' } }));
  assert.equal(again.status, 200); // reused, not created
  assert.equal(again.body.id, first.body.id);
  assert.equal(again.body.definition, 'Uses irony to criticize.'); // back-filled the empty definition
});

test('edits a definition', async () => {
  const { body: all } = await api('/genres');
  const mystery = all.find((g) => g.name === 'Mystery');
  const { status, body } = await api('/genres/' + mystery.id, json({ method: 'PUT', data: { definition: 'Updated definition.' } }));
  assert.equal(status, 200);
  assert.equal(body.definition, 'Updated definition.');
  assert.equal(body.name, 'Mystery'); // unchanged
});

test('deleting a top-level genre cascades to its subgenres', async () => {
  const created = await api('/genres', json({ method: 'POST', data: { name: 'Temp', definition: 't' } }));
  await api('/genres', json({ method: 'POST', data: { name: 'TempChild', definition: 'c', parent_id: created.body.id } }));
  const del = await api('/genres/' + created.body.id, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const { body: after } = await api('/genres');
  assert.equal(after.some((g) => g.name === 'Temp' || g.name === 'TempChild'), false);
});
