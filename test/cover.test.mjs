// Covers are served from their own endpoint, referenced by URL. If that URL
// stays the same when the image changes, a browser keeps showing the copy it
// already has and a saved photo looks like it never saved — which is exactly
// what happened after re-shooting a cover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = 3196;
const BASE = `http://127.0.0.1:${PORT}/library`;
const DB_PATH = `/tmp/home-library-cover-${process.pid}.db`;
let server;

const api = async (path, opts) => {
  const r = await fetch(BASE + '/api' + path, opts);
  return { status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json() };
};
const send = (method, data) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
// A 1x1 JPEG-ish payload is enough: nothing here decodes it.
const dataUrl = (marker) => `data:image/jpeg;base64,${Buffer.from(`fake-jpeg-${marker}`).toString('base64')}`;

test.before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), BASE_PATH: '/library', DB_PATH },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(BASE + '/api/meta')).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(() => {
  if (server) server.kill('SIGKILL');
  for (const ext of ['', '-shm', '-wal']) { try { rmSync(DB_PATH + ext, { force: true }); } catch { /* ignore */ } }
});

test('replacing a cover changes its URL, so the new photo is the one shown', async () => {
  const book = (await api('/books', send('POST', { title: 'Reshot', cover_url: dataUrl('first') }))).body;
  const first = (await api(`/books/${book.id}`)).body.cover_url;
  assert.match(first, /^api\/books\/\d+\/cover\?v=/, 'cover is referenced with a version');

  await api(`/books/${book.id}`, send('PUT', { cover_url: dataUrl('second') }));
  const second = (await api(`/books/${book.id}`)).body.cover_url;
  assert.notEqual(second, first, 'a different image must be a different URL');

  // ...and the bytes really did change.
  const bytes = await (await fetch(`${BASE}/${second}`)).text();
  assert.match(bytes, /fake-jpeg-second/);

  // Re-saving the same image keeps the same URL, so caches stay useful.
  await api(`/books/${book.id}`, send('PUT', { title: 'Reshot again' }));
  assert.equal((await api(`/books/${book.id}`)).body.cover_url, second, 'unchanged image keeps its URL');
});

test('a versioned cover may be cached hard; a bare one may not', async () => {
  const book = (await api('/books', send('POST', { title: 'Cache', cover_url: dataUrl('c') }))).body;
  const ref = (await api(`/books/${book.id}`)).body.cover_url;

  const versioned = await fetch(`${BASE}/${ref}`);
  assert.match(versioned.headers.get('cache-control'), /immutable/, 'versioned URL is immutable');

  const bare = await fetch(`${BASE}/api/books/${book.id}/cover`);
  assert.match(bare.headers.get('cache-control'), /no-cache/, 'bare URL must be revalidated');
});

test('saving a book that echoes back the cover reference keeps the image', async () => {
  const book = (await api('/books', send('POST', { title: 'Echo', cover_url: dataUrl('keep') }))).body;
  const ref = (await api(`/books/${book.id}`)).body.cover_url;

  // This is what the edit form sends back when the cover was not touched.
  await api(`/books/${book.id}`, send('PUT', { title: 'Echo edited', cover_url: ref }));
  const after = (await api(`/books/${book.id}`)).body;
  assert.equal(after.title, 'Echo edited');
  assert.equal(after.cover_url, ref, 'the reference did not overwrite the image');
  assert.match(await (await fetch(`${BASE}/${ref}`)).text(), /fake-jpeg-keep/);
});

// Served assets carry the app version, so a release is a new URL. Without it a
// phone can run last week's stylesheet against this week's server, which is how
// a fixed layout bug went on being reported as broken.
test('every stylesheet and script is requested with the app version', async () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const html = await (await fetch(`${BASE}/`)).text();

  const refs = [...html.matchAll(/(?:href|src)="([^"]+\.(?:css|js))(\?[^"]*)?"/g)];
  assert.ok(refs.length >= 6, `found ${refs.length} asset references`);
  for (const [, file, query] of refs) {
    assert.equal(query, `?v=${version}`, `${file} must carry ?v=${version}`);
  }
  assert.doesNotMatch(html, /__V__/, 'the placeholder is substituted, not shipped');

  // And the URL actually serves the file, rather than 404ing on the query.
  const one = await fetch(`${BASE}/styles.css?v=${version}`);
  assert.equal(one.status, 200);
});
