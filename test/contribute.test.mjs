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
// Its own covers directory: they default to one beside the database, so every
// test database in /tmp would otherwise share /tmp/covers and overwrite each
// other's files — copy ids restart at 1 in each. See cover.test.mjs.
const COVERS_DIR = DB_PATH.replace(/\.db$/, '-covers');

let server, olServer;
const olRequests = [];
// What the stub says Open Library holds. Mutable, so a test can let Open
// Library acquire a field between two scans — which is the whole point of the
// proposals that close themselves.
let stubRecord = {
  key: '/books/OL42M',
  number_of_pages: 300,   // already known: must never be offered
  covers: [999],          // already has a cover: must never be offered
};

test.before(async () => {
  // Stub Open Library: one edition with a cover and a page count already, and
  // nothing else — so exactly the empty fields should come back as proposals.
  olServer = createServer((req, res) => {
    olRequests.push(req.url);
    if (req.url.startsWith('/isbn/9780000000019')) {   // deliberately unknown to OL
      res.statusCode = 404;
      return res.end('{}');
    }
    if (req.url.startsWith('/isbn/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(stubRecord));
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
      COVERS_DIR,
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
  rmSync(COVERS_DIR, { recursive: true, force: true });
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
      COVERS_DIR,
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
  // Proposals key on the edition now: the edit targets Open Library's record
  // for the ISBN, not one shelf's copy of it.
  const mine = queue.filter((r) => r.edition_id === made.edition_id);
  const fields = mine.map((r) => r.field).sort();
  // cover_from_ol is the inbound proposal, and belongs here precisely because
  // Open Library already has a cover: it offers to adopt theirs in place of the
  // photograph, which is the mirror image of never offering them a cover they
  // already hold.
  assert.deepEqual(fields, ['cover_from_ol', 'physical_dimensions', 'physical_format'],
    'the page count and cover Open Library already has are not offered back to it');
  assert.equal(mine.find((r) => r.field === 'physical_dimensions').value, '20 x 13 x 2 centimeters');
  assert.equal(mine[0].olid, 'OL42M', 'proposals name the edition they would edit');

  // Scanning again must not stack up a second copy of the same proposal.
  await post('/api/ol-contributions/scan');
  const again = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  assert.equal(again.filter((r) => r.edition_id === made.edition_id).length, 3, 'no duplicates');

  // Nothing can be sent while the account is unconfigured, and the queue says so.
  const status = await (await fetch(`${BASE}/api/ol-contributions/status`)).json();
  assert.equal(status.configured, false);
  // A row that would actually be SENT. Adopting Open Library's cover sends
  // nothing and is allowed without an account, so it would pass this check for
  // the wrong reason.
  const sendable = mine.find((r) => r.field === 'physical_dimensions');
  const approve = await post(`/api/ol-contributions/${sendable.id}/approve`);
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
    title: 'Not In Open Library', isbn: '9780000000019',
    authors: 'A Writer', publisher: 'A Press', published_date: '2024',
    height_mm: 200, width_mm: 130, thickness_mm: 20, format: 'paperback',
  })).json();

  // The stub 404s this ISBN (it only answers /isbn/ for the one it knows). The
  // ISBN has a real check digit: an unverifiable one is refused for import, so
  // a placeholder that failed its check digit would pass this test for the
  // wrong reason and then hide the switch being broken.
  await post('/api/ol-contributions/scan');
  let queue = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  assert.equal(queue.some((r) => r.edition_id === made.edition_id && r.field === 'import'), false,
    'switched off by default: nothing is queued for creation');

  // Restart with the switch on and a source prefix, then scan again.
  await restartServer({ OPENLIBRARY_ALLOW_IMPORT: 'true', OPENLIBRARY_SOURCE_PREFIX: 'testbot' });
  await post('/api/ol-contributions/scan');
  queue = await (await fetch(`${BASE}/api/ol-contributions`)).json();
  const imp = queue.find((r) => r.edition_id === made.edition_id && r.field === 'import');
  assert.ok(imp, 'switched on: the missing book is proposed as a new record');
  assert.equal(imp.olid, 'NEW', 'there is no record to point at yet');
  assert.equal(imp.label, 'New record');
});

// ─── proposals that answer themselves, and the one that runs inwards ─────────

const dataUrl = (marker) => `data:image/jpeg;base64,${Buffer.from(`fake-jpeg-${marker}`).toString('base64')}`;
const queue = async (status = 'pending') => (await (await fetch(`${BASE}/api/ol-contributions?status=${status}`)).json());

// A proposal is a claim about what Open Library was missing when we looked.
// Somebody else filling the gap is the good outcome, and the row has to notice:
// three cover rows sat as `failed` for books Open Library had since acquired
// covers for, because the queue only ever inserted.
test('a gap somebody else has since filled closes itself', async () => {
  const made = await (await post('/api/books', {
    title: 'Filled In Later', isbn: '9780000000002',
    height_mm: 198, width_mm: 129, thickness_mm: 18, format: 'paperback',
  })).json();

  await post('/api/ol-contributions/scan');
  const open = (await queue()).find((r) => r.edition_id === made.edition_id && r.field === 'physical_dimensions');
  assert.ok(open, 'the gap is proposed while it is a gap');

  // Open Library acquires the value we were going to offer.
  stubRecord = { ...stubRecord, physical_dimensions: '19.8 x 12.9 x 1.8 centimeters' };
  const again = await (await post('/api/ol-contributions/scan')).json();
  assert.ok(again.satisfied >= 1, 'the scan reports what it closed');

  assert.equal((await queue()).some((r) => r.id === open.id), false, 'no longer waiting for a decision');
  assert.equal((await queue('satisfied')).some((r) => r.id === open.id), true, 'recorded as answered, not as declined');
  stubRecord = { ...stubRecord, physical_dimensions: undefined };
});

// The inverse of every other proposal: Open Library has the cover, we have the
// photograph, and adopting theirs DELETES ours. Hence a queued row rather than
// something a scan does on its own.
test('Open Library\'s cover is offered in place of a photograph, and adopting it removes the photograph', async () => {
  const made = await (await post('/api/books', {
    title: 'Photographed Here', isbn: '9780000000026', cover_url: dataUrl('mine'),
  })).json();
  assert.match(made.cover_url, /\/cover/, 'the copy carries a photograph');

  await post('/api/ol-contributions/scan');
  const row = (await queue()).find((r) => r.edition_id === made.edition_id && r.field === 'cover_from_ol');
  assert.ok(row, 'the adoption is proposed');
  assert.equal(row.value, 'https://covers.openlibrary.org/b/id/999-L.jpg', 'and names the image it would adopt');
  assert.equal(row.copy_id, made.id, 'with the copy whose photograph is at stake, for comparison');

  // Nothing is deleted by proposing it.
  assert.equal((await (await fetch(`${BASE}/api/books/${made.id}`)).json()).cover_url.includes('/cover'), true);

  // Approving needs no Open Library account: it sends nothing.
  const done = await (await post(`/api/ol-contributions/${row.id}/approve`)).json();
  assert.equal(done.ok, true);
  assert.equal(done.photographsRemoved, 1);

  const after = await (await fetch(`${BASE}/api/books/${made.id}`)).json();
  assert.equal(after.cover_url, 'https://covers.openlibrary.org/b/id/999-L.jpg', 'the edition now shows theirs');
  const gone = await fetch(`${BASE}/api/books/${made.id}/cover`, { redirect: 'manual' });
  assert.equal(gone.status, 302, 'the photograph is gone from disk');
  assert.equal(gone.headers.get('location'), row.value, 'and the copy falls back to the adopted artwork');
  assert.equal((await queue('applied')).some((r) => r.id === row.id), true);
});

// The default sweep is ordered by what changed recently, so a book catalogued a
// year ago is never reached — which is why 13 of 19 photographed books had
// never been looked at.
test('the covers sweep looks only at books carrying a photograph', async () => {
  const { scanned } = await (await post('/api/ol-contributions/scan', { scope: 'covers', limit: 100 })).json();
  const withPhotos = (await (await fetch(`${BASE}/api/books?limit=200`)).json())
    .filter((b) => (b.cover_url || '').startsWith('api/books/')).length;
  assert.equal(scanned, withPhotos, 'every photographed book and nothing else');
});

// The cover leaves this app through Open Library's own form, in a browser, so
// nothing here can know the upload happened. Skip would record a decision never
// to offer the book again, which is the opposite of what happened.
test('a cover row can be re-checked after a by-hand upload, and only closes if it really arrived', async () => {
  stubRecord = { ...stubRecord, covers: undefined };   // Open Library has no cover
  const made = await (await post('/api/books', {
    title: 'Uploaded By Hand', isbn: '9780000000033', cover_url: dataUrl('hand'),
  })).json();

  await post('/api/ol-contributions/scan', { scope: 'covers', limit: 100 });
  const row = (await queue()).find((r) => r.edition_id === made.edition_id && r.field === 'cover');
  assert.ok(row, 'the cover is offered while Open Library lacks one');

  // Checking before the upload has landed must leave the row exactly as it was:
  // a re-check that dismissed on request would lose a failed upload silently.
  const tooSoon = await (await post(`/api/ol-contributions/${row.id}/recheck`)).json();
  assert.equal(tooSoon.closed, false, 'nothing to close yet');
  assert.equal((await queue()).some((r) => r.id === row.id), true, 'still waiting');

  // Now it arrives, by a route this app cannot see.
  stubRecord = { ...stubRecord, covers: [4242] };
  const done = await (await post(`/api/ol-contributions/${row.id}/recheck`)).json();
  assert.equal(done.closed, true);
  assert.equal(done.status, 'satisfied', 'recorded as answered, not declined');
  assert.equal((await queue()).some((r) => r.id === row.id), false, 'gone from the queue');

  // And the same look offers the mirror image, exactly as a full sweep would.
  const adopt = (await queue()).find((r) => r.edition_id === made.edition_id && r.field === 'cover_from_ol');
  assert.ok(adopt, 'the adoption is proposed by the same re-check');
  assert.equal(adopt.value, 'https://covers.openlibrary.org/b/id/4242-L.jpg');
  stubRecord = { ...stubRecord, covers: [999] };
});
