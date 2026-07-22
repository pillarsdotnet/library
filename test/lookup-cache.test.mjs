// The lookup cache: a book already answered is not looked up again, so a
// re-scan, a retry, or a second glance at the same book does not spend another
// query against a rate-limited service. Every answer — found or not — is kept
// at least 24 hours, and when a source is throttled, stale cache is served in
// preference to no data. A rate-limit is itself never cached.
//
// A controllable stub stands in for Open Library and Google Books — the point
// is to count and steer upstream calls, which the real services cannot do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3209;
const OL_PORT = 3210;
const GB_PORT = 3213;
const BASE = `http://127.0.0.1:${PORT}/library`;
const DB_PATH = `/tmp/home-library-lookupcache-${process.pid}.db`;

let server, olServer, gbServer;
let olHits = 0;
let gbHits = 0;
// Steer the stub between tests: which ISBN Open Library "has", and whether
// Google Books is throttling.
const stub = { olKnows: new Set(['9781451638356']), gbRateLimited: false };
const KNOWN = '9781451638356';

test.before(async () => {
  olServer = createServer((req, res) => {
    olHits += 1;
    res.setHeader('Content-Type', 'application/json');
    const known = [...stub.olKnows].find((i) => req.url.includes(i));
    if (req.url.includes('/api/books') && known) {
      return res.end(JSON.stringify({
        [`ISBN:${known}`]: {
          title: 'War maid\'s choice',
          authors: [{ name: 'David Weber' }],
          publishers: [{ name: 'Baen Books' }],
          publish_date: '2012',
        },
      }));
    }
    if (req.url.startsWith('/isbn/') && known) {
      return res.end(JSON.stringify({ physical_format: 'Hardcover' }));  // format present → no B&N fallback
    }
    res.statusCode = req.url.includes('/api/books') ? 200 : 404;
    res.end('{}');
  });
  gbServer = createServer((req, res) => {
    gbHits += 1;
    if (stub.gbRateLimited) { res.statusCode = 429; return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  await new Promise((r) => olServer.listen(OL_PORT, r));
  await new Promise((r) => gbServer.listen(GB_PORT, r));

  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      BASE_PATH: '/library',
      DB_PATH,
      OPENLIBRARY_BASE: `http://127.0.0.1:${OL_PORT}`,
      GOOGLE_BOOKS_BASE: `http://127.0.0.1:${GB_PORT}`,
      BARNESNOBLE_BASE: `http://127.0.0.1:${OL_PORT}`,   // kept off the internet; returns nothing useful
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
  if (gbServer) await new Promise((r) => gbServer.close(r));
  for (const suffix of ['', '-shm', '-wal']) rmSync(DB_PATH + suffix, { force: true });
});

const look = (isbn, qs = '') => fetch(`${BASE}/api/lookup/${isbn}${qs}`);

test('a found lookup is served from cache the second time, with no upstream call', async () => {
  olHits = 0; gbHits = 0;
  const first = await look(KNOWN);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-lookup-cache'), 'miss', 'first time is a miss');
  assert.equal((await first.json()).title, 'War maid\'s choice');
  const afterFirst = olHits + gbHits;
  assert.ok(afterFirst > 0, 'the first lookup went upstream');

  const second = await look(KNOWN);
  assert.equal(second.headers.get('x-lookup-cache'), 'hit', 'second time is a hit');
  assert.equal((await second.json()).title, 'War maid\'s choice');
  assert.equal(olHits + gbHits, afterFirst, 'the cached hit made no upstream call');
});

test('a not-found is cached too, so a repeat miss costs no query', async () => {
  olHits = 0;
  const first = await look('9780000000404');
  assert.equal(first.status, 404);
  assert.equal(first.headers.get('x-lookup-cache'), 'miss');
  const afterFirst = olHits;
  assert.ok(afterFirst > 0, 'the first miss went upstream');

  const second = await look('9780000000404');
  assert.equal(second.status, 404);
  assert.equal(second.headers.get('x-lookup-cache'), 'hit', 'the miss was cached and retained');
  assert.equal(olHits, afterFirst, 'the repeat miss made no upstream call');
});

test('?refresh=1 bypasses the cache and re-fetches', async () => {
  await look(KNOWN);                       // ensure cached
  olHits = 0; gbHits = 0;
  const refreshed = await look(KNOWN, '?refresh=1');
  assert.equal(refreshed.headers.get('x-lookup-cache'), 'miss', 'refresh forces a miss');
  assert.ok(olHits + gbHits > 0, 'refresh actually hit upstream again');
});

test('a rate-limited source falls back to stale cache rather than failing', async () => {
  await look(KNOWN);                       // seed the cache with a good result
  // Now make every source fail for this ISBN: Open Library forgets it and
  // Google Books throttles, so the lookup would raise RateLimitError.
  stub.olKnows.delete(KNOWN);
  stub.gbRateLimited = true;
  try {
    const r = await look(KNOWN, '?refresh=1');   // refresh, so it must go upstream and fail
    assert.equal(r.status, 200, 'stale data is served, not an error');
    assert.equal(r.headers.get('x-lookup-cache'), 'stale');
    assert.equal((await r.json()).title, 'War maid\'s choice', 'the last-known metadata comes back');

    // ...but a book never cached has nothing to fall back on, so it errors.
    const cold = await look('9780000000911');
    assert.equal(cold.status, 503, 'no cache + throttled = a clean 503');
  } finally {
    stub.olKnows.add(KNOWN);
    stub.gbRateLimited = false;
  }
});
