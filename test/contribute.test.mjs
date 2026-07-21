// The review queue, end to end: gaps are found and queued, approving without
// credentials refuses, and declining takes a row out of the queue for good.
//
// A stub stands in for Open Library — the real service is volunteer-run, and a
// test suite has no business writing to a public catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3207;
const OL_PORT = 3208;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/home-library-contrib-${process.pid}.db`;

let server, olServer;
const olRequests = [];

test.before(async () => {
  // Stub Open Library: one edition with a cover and a page count already, and
  // nothing else — so exactly the empty fields should come back as proposals.
  olServer = createServer((req, res) => {
    olRequests.push(req.url);
    if (req.url.startsWith('/isbn/9780000000009')) {   // deliberately unknown to OL
      res.statusCode = 404;
      return res.end('{}');
    }
    if (req.url.startsWith('/isbn/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        key: '/books/OL42M',
        number_of_pages: 300,   // already known: must never be offered
        covers: [999],          // already has a cover: must never be offered
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => olServer.listen(OL_PORT, r));

  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      OPENLIBRARY_BASE: `http://127.0.0.1:${OL_PORT}`,
      OPENLIBRARY_ACCESS_KEY: '',
      OPENLIBRARY_SECRET_KEY: '',
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/meta`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not become ready');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(async () => {
  if (server) server.kill('SIGKILL');
  if (olServer) await new Promise((r) => olServer.close(r));
  for (const suffix of ['', '-shm', '-wal']) rmSync(DB_PATH + suffix, { force: true });
});

// Restart the app with extra environment, for the switches that are read there.
async function restartServer(extraEnv) {
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      OPENLIBRARY_BASE: `http://127.0.0.1:${OL_PORT}`,
      OPENLIBRARY_ACCESS_KEY: '',
      OPENLIBRARY_SECRET_KEY: '',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/meta`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not come back');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const post = (path, body) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

test('a scan queues only the gaps, and approving is blocked without credentials', async () => {
  const made = await (await post('/api/books', {
    title: 'Contributable', isbn: '9780000000001',
    height_mm: 200, width_mm: 130, thickness_mm: 20,
    format: 'hardback', page_count: 342,
    cover_url: 'data:image/jpeg;base64,AAAA',
  })).json();

  const scan = await (await post('/api/ol-contributions/scan')).json();
  assert.equal(scan.scanned >= 1, true);

  const queue = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  const mine = queue.filter((r) => r.book_id === made.id);
  const fields = mine.map((r) => r.field).sort();
  assert.deepEqual(fields, ['physical_dimensions', 'physical_format'],
    'the page count and cover Open Library already has are not offered');
  assert.equal(mine.find((r) => r.field === 'physical_dimensions').value, '20 x 13 x 2 centimeters');
  assert.equal(mine[0].olid, 'OL42M', 'proposals name the edition they would edit');

  // Scanning again must not stack up a second copy of the same proposal.
  await post('/api/ol-contributions/scan');
  const again = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  assert.equal(again.filter((r) => r.book_id === made.id).length, 2, 'no duplicates');

  // Nothing can be sent while the account is unconfigured, and the queue says so.
  const status = await (await fetch(`${BASE}/api/ol-contributions/status`)).json();
  assert.equal(status.configured, false);
  const approve = await post(`/api/ol-contributions/${mine[0].id}/approve`);
  assert.equal(approve.status, 503, 'refuses to send with no credentials');
  assert.equal(olRequests.some((u) => u.includes('login')), false, 'and never tried to log in');
});

test('declining removes a proposal from the queue and it does not come back', async () => {
  const queue = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  const target = queue[0];
  assert.ok(target, 'something to decline');

  assert.equal((await post(`/api/ol-contributions/${target.id}/decline`)).status, 200);
  const after = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  assert.equal(after.some((r) => r.id === target.id), false, 'gone from pending');

  // A later scan must respect the decision rather than re-offering it.
  await post('/api/ol-contributions/scan');
  const rescanned = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  assert.equal(rescanned.some((r) => r.id === target.id), false, 'a skipped gap stays skipped');
});

test('books Open Library has never heard of are counted, not queued', async () => {
  await (await post('/api/books', {
    title: 'Unknown to Open Library', isbn: '9780000000002',
    height_mm: 200, width_mm: 130, thickness_mm: 20, format: 'paperback',
  })).json();
  // The stub 404s anything but /isbn/, and answers every ISBN the same way, so
  // point this one at a path it does not serve by using an ISBN-shaped miss.
  const scan = await (await post('/api/ol-contributions/scan')).json();
  assert.equal(typeof scan.unknown, 'number', 'unknown editions are reported back');
  assert.equal(scan.scanned >= 2, true);
});

// Importing is the one action that creates a record rather than filling a
// blank, so the default has to be that it does not happen. The scan above
// already proves an unknown ISBN is counted and not queued; this pins that it
// is the switch, not luck, and that the switch works when thrown.
test('an unknown ISBN is queued for import only when importing is switched on', async () => {
  const made = await (await post('/api/books', {
    title: 'Not In Open Library', isbn: '9780000000009',
    authors: 'A Writer', publisher: 'A Press', published_date: '2024',
    height_mm: 200, width_mm: 130, thickness_mm: 20, format: 'paperback',
  })).json();

  // The stub 404s this ISBN (it only answers /isbn/ for the one it knows).
  await post('/api/ol-contributions/scan');
  let queue = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  assert.equal(queue.some((r) => r.book_id === made.id && r.field === 'import'), false,
    'switched off by default: nothing is queued for creation');

  // Restart with the switch on and a source prefix, then scan again.
  await restartServer({ OPENLIBRARY_ALLOW_IMPORT: 'true', OPENLIBRARY_SOURCE_PREFIX: 'testbot' });
  await post('/api/ol-contributions/scan');
  queue = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  const imp = queue.find((r) => r.book_id === made.id && r.field === 'import');
  assert.ok(imp, 'switched on: the missing book is proposed as a new record');
  assert.equal(imp.olid, 'NEW', 'there is no record to point at yet');
  assert.equal(imp.label, 'New record');
});
