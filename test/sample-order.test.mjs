// The unfiltered Books tab shows a random sampling: `seed` on GET /api/books
// returns the listing in that seed's shuffle instead of filed alphabetically.
// One seed names ONE complete ordering, so paging with limit/offset walks the
// whole library exactly once — no book repeated, none skipped — and a
// different seed deals differently. The server guarantees the sampling: an
// unfiltered request whose seed is missing or junk is REDIRECTED to the same
// URL with a freshly minted seed, so the address always names the deal it
// shows. `seed=0` is the one explicit refusal — filed order, whole catalogue —
// and any real filter files as it always did, seed or no seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3281;           // grep `PORT = ` across test/ before picking one
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/home-library-sample-order-${process.pid}.db`;
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

  // Twelve books, entered already alphabetized by author so that "came back in
  // entry order" and "came back filed" are the same wrong answer, caught once.
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/api/books', {
      title: `Book ${String.fromCharCode(65 + i)}`,
      authors: `Author ${String.fromCharCode(65 + i)}`,
      format: 'paperback',
    });
    assert.equal(r.status, 201);
  }
});

test.after(() => {
  server?.kill();
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  rmSync(COVERS_DIR, { recursive: true, force: true });
});

const titles = async (query) => (await api('GET', `/api/books?${query}`)).body.map((b) => b.title);

test('a seed shuffles the listing without losing or repeating a book', async () => {
  const filed = await titles('limit=0&seed=0');
  const sampled = await titles('limit=0&seed=12345');
  assert.equal(sampled.length, filed.length);
  assert.deepEqual([...sampled].sort(), [...filed].sort());   // a permutation —
  assert.notDeepEqual(sampled, filed);                        // — and a real one
});

test('paging with one seed walks one shuffle, page by page', async () => {
  const whole = await titles('limit=0&seed=12345');
  const paged = [];
  for (let offset = 0; offset < whole.length; offset += 5) {
    paged.push(...await titles(`limit=5&offset=${offset}&seed=12345`));
  }
  assert.deepEqual(paged, whole);
});

test('a different seed deals differently; seed=0 files alphabetically', async () => {
  const first = await titles('limit=0&seed=12345');
  const second = await titles('limit=0&seed=54321');
  assert.notDeepEqual(second, first);

  const filed = await titles('limit=0&seed=0');
  assert.deepEqual(filed, [...filed].sort());   // Author A … Author L
});

// The seed the redirect minted, pulled from its Location header — which must
// point back at /api/books with every original parameter kept.
async function mintedSeed(query) {
  const res = await fetch(`${BASE}/api/books${query ? '?' + query : ''}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get('location'), BASE);
  assert.equal(to.pathname, '/api/books');
  for (const [k, v] of new URLSearchParams(query)) {
    if (k !== 'seed') assert.equal(to.searchParams.get(k), v, `redirect kept ${k}`);
  }
  const seed = Number(to.searchParams.get('seed'));
  assert.ok(Number.isSafeInteger(seed) && seed > 0, `a real seed, got ${to.searchParams.get('seed')}`);
  return seed;
}

test('unfiltered and seedless redirects to a freshly seeded URL', async () => {
  const seed = await mintedSeed('limit=5&offset=0');
  // Following the minted address deals that seed's shuffle of the catalogue.
  const sampled = await titles(`limit=0&seed=${seed}`);
  const filed = await titles('limit=0&seed=0');
  assert.deepEqual([...sampled].sort(), [...filed].sort());
  // Two mints almost surely differ; what matters is each names a usable deal.
  assert.notEqual(await mintedSeed(''), seed);
});

test('a junk seed is bounced the same way as a missing one', async () => {
  for (const junk of ['please', '1.5', 'NaN', 'Infinity', '']) {
    await mintedSeed(`seed=${encodeURIComponent(junk)}&limit=20`);
  }
});

test('with a filter there is no sampling and no redirect, junk seed or none', async () => {
  for (const query of ['q=Book', 'q=Book&seed=please']) {
    const res = await fetch(`${BASE}/api/books?${query}&limit=0`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const got = (await res.json()).map((b) => b.title);
    assert.deepEqual(got, [...got].sort());   // filed, not dealt
  }
});
