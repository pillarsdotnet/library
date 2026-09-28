// Two libraries on one server, and nothing crossing between them.
//
// Each check below is written so that it fails if the library scoping on that
// route were simply absent: library B asks for, edits, deletes or links to
// something library A owns, by id, and must get exactly what it would for an
// id that does not exist. A leak between tenants fails silently — the app
// works, for the wrong people — so every route is asked directly rather than
// trusted by inspection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3221;
const GOOGLE_PORT = 3222;
const OL_PORT = 3223;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), 'home-library-tenancy-'));
const DB_PATH = join(TMP, 'library.db');
const COVERS_DIR = join(TMP, 'covers');
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

// Open Library's keys that the stub accepts. Anything else is refused.
const GOOD_KEYS = { access: 'good-access-key-1234', secret: 'good-secret-key-do-not-store-plain' };

let server, google, ol;
let nextEmail = null;

function idToken(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.x`;
}

test.before(async () => {
  google = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${GOOGLE_PORT}`);
    if (url.pathname === '/auth') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'c');
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id_token: idToken({
      aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 3600,
      email: nextEmail, email_verified: true,
    }) }));
  });
  ol = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/account/login.json') {
        const { access, secret } = JSON.parse(body || '{}');
        if (access === GOOD_KEYS.access && secret === GOOD_KEYS.secret) {
          res.writeHead(200, { 'Set-Cookie': 'session=/people/tester%2Cabc; Path=/' });
          return res.end('{}');
        }
        res.writeHead(401);
        return res.end('{"error":"bad keys"}');
      }
      if (req.url.startsWith('/isbn/')) {
        // An edition with every physical field blank, so a scan proposes them.
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ key: '/books/OL42M', number_of_pages: 300, covers: [1] }));
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise((r) => google.listen(GOOGLE_PORT, '127.0.0.1', r));
  await new Promise((r) => ol.listen(OL_PORT, '127.0.0.1', r));

  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH, COVERS_DIR,
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_AUTH_URL: `http://127.0.0.1:${GOOGLE_PORT}/auth`,
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${GOOGLE_PORT}/token`,
      AUTH_ALLOWED_FILE: join(TMP, 'none.txt'),
      SESSION_SECRET: 'tenancy-secret',
      OPENLIBRARY_BASE: `http://127.0.0.1:${OL_PORT}`,
      // Present in the environment, and ignored with sign-in on: keys are users'.
      OPENLIBRARY_ACCESS_KEY: GOOD_KEYS.access,
      OPENLIBRARY_SECRET_KEY: GOOD_KEYS.secret,
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${BASE}/auth/me`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not become ready');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(async () => {
  if (server) server.kill('SIGKILL');
  await Promise.all([google, ol].map((s) => s && new Promise((r) => s.close(r))));
  rmSync(TMP, { recursive: true, force: true });
});

async function signIn(email, library) {
  nextEmail = email;
  const post = await fetch(`${BASE}/auth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ library }).toString(),
  });
  const flow = (post.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const atGoogle = await fetch(post.headers.get('location'), { redirect: 'manual' });
  const cb = await fetch(atGoogle.headers.get('location'), { redirect: 'manual', headers: { Cookie: flow } });
  const session = (cb.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('hl_session='));
  assert.ok(session, `${email} signed in to ${library}`);
  return session;
}

// A tiny client bound to one session.
function client(session) {
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, {
      method,
      headers: { Cookie: session, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b = {}) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

let A, B;       // clients for the two libraries
let a;          // what library A owns
const ISBN = '9780306406157';

test('two libraries, each with its own things', async () => {
  A = client(await signIn('alice@gmail.com', 'Alpha'));
  B = client(await signIn('bob@gmail.com', 'Beta'));

  const shelf = (await A.post('/api/shelves', { label: 'A shelf', room: 'A room', width_mm: 800 })).data;
  const genre = (await A.post('/api/genres', { name: 'Alpha Only Genre' })).data;
  const book = (await A.post('/api/books', {
    title: 'Alpha Book', isbn: ISBN, shelf_id: shelf.id, genre_ids: [genre.id], thickness_mm: 30,
  })).data;
  const series = (await A.post('/api/series', { title: 'Alpha Saga' })).data;
  assert.equal((await A.post(`/api/series/${series.id}/books`, { book_id: book.id, order: 1 })).status, 201);
  a = { shelf, genre, book, series };
  assert.equal(book.shelf_id, shelf.id);
  assert.deepEqual(book.genre_ids, [genre.id]);
});

test('lists show only your own library', async () => {
  assert.deepEqual((await B.get('/api/books')).data, [], 'no books');
  assert.deepEqual((await B.get('/api/shelves')).data, [], 'no shelves');
  assert.deepEqual((await B.get('/api/series')).data, [], 'no series');
  const genres = (await B.get('/api/genres')).data;
  assert.ok(genres.length > 10, 'its own stock genres');
  assert.ok(!genres.some((g) => g.name === 'Alpha Only Genre'), 'none of the other library\'s');
  const meta = (await B.get('/api/meta')).data;
  assert.deepEqual(meta, { rooms: [], bookcases: [], count: 0, unshelved: 0 });
  const suggest = (await B.post('/api/suggest-shelf', { thickness_mm: 20 })).data;
  assert.deepEqual([...suggest.suggestions, ...suggest.rejected], [], 'no shelves to suggest');
  // The filters cannot reach across either.
  assert.deepEqual((await B.get(`/api/books?shelf_id=${a.shelf.id}`)).data, []);
  assert.deepEqual((await B.get(`/api/books?genre_id=${a.genre.id}`)).data, []);
  assert.deepEqual((await B.get(`/api/books?series_id=${a.series.id}`)).data, []);
  assert.deepEqual((await B.get('/api/books?q=Alpha')).data, []);
});

test('another library\'s ids are not found, and nothing is changed through them', async () => {
  const id = a.book.id;
  for (const [what, r] of [
    ['book', await B.get(`/api/books/${id}`)],
    ['cover', await B.get(`/api/books/${id}/cover`)],
    ['cover source', await B.get(`/api/books/${id}/cover-source`)],
    ['book edit', await B.put(`/api/books/${id}`, { title: 'Hijacked' })],
    ['book delete', await B.del(`/api/books/${id}`)],
    ['shelf', await B.get(`/api/shelves/${a.shelf.id}`)],
    ['shelf edit', await B.put(`/api/shelves/${a.shelf.id}`, { label: 'Hijacked' })],
    ['shelf delete', await B.del(`/api/shelves/${a.shelf.id}`)],
    ['bookcase move', await B.put('/api/bookcases', { from: { room: 'A room', bookcase: '' }, room: 'Hijacked' })],
    ['series books', await B.get(`/api/series/${a.series.id}/books`)],
    ['series place', await B.post(`/api/series/${a.series.id}/books`, { book_id: id, order: 2 })],
    ['series remove', await B.del(`/api/series/${a.series.id}/books/${id}`)],
    ['genre edit', await B.put(`/api/genres/${a.genre.id}`, { name: 'Hijacked' })],
    ['genre delete', await B.del(`/api/genres/${a.genre.id}`)],
  ]) assert.equal(r.status, 404, `${what}: ${JSON.stringify(r.data)}`);

  // And library A still has everything, unchanged.
  const book = (await A.get(`/api/books/${id}`)).data;
  assert.equal(book.title, 'Alpha Book');
  assert.equal(book.series.title, 'Alpha Saga');
  assert.equal((await A.get(`/api/shelves/${a.shelf.id}`)).data.label, 'A shelf');
  assert.equal((await A.get(`/api/shelves/${a.shelf.id}`)).data.room, 'A room');
  assert.ok((await A.get('/api/genres')).data.some((g) => g.name === 'Alpha Only Genre'));
});

test('another library\'s shelf, genre, series or book cannot be linked to', async () => {
  const onTheirShelf = await B.post('/api/books', { title: 'Beta Book', shelf_id: a.shelf.id });
  assert.equal(onTheirShelf.status, 400, 'a book cannot be put on another library\'s shelf');

  const mine = (await B.post('/api/books', { title: 'Beta Book', genre_ids: [a.genre.id] })).data;
  assert.deepEqual(mine.genre_ids, [], 'another library\'s genre is ignored like an unknown one');
  assert.equal((await B.put(`/api/books/${mine.id}`, { shelf_id: a.shelf.id })).status, 400, 'nor moved onto one');

  assert.equal((await B.post('/api/genres', { name: 'Sub', parent_id: a.genre.id })).status, 400,
    'a genre cannot sit under another library\'s');
  const theirSeries = (await B.post('/api/series', { title: 'Beta Saga' })).data;
  assert.equal((await B.post(`/api/series/${theirSeries.id}/books`, { book_id: a.book.id, order: 1 })).status, 400,
    'another library\'s book cannot join your series');
  assert.equal((await B.post('/api/suggest-shelf', { book_id: a.book.id, thickness_mm: 20 })).status, 200);
});

test('the same ISBN is a separate edition in each library', async () => {
  const theirs = (await B.post('/api/books', { title: 'Beta Edition', isbn: ISBN, publisher: 'Beta Press' })).data;
  assert.notEqual(theirs.edition_id, a.book.edition_id, 'not merged with the other library\'s edition');
  await B.put(`/api/books/${theirs.id}`, { title: 'Renamed by Beta' });
  assert.equal((await A.get(`/api/books/${a.book.id}`)).data.title, 'Alpha Book', 'an edit in one library leaves the other alone');
  assert.equal((await A.get(`/api/books/${a.book.id}`)).data.publisher, null, 'nor fills its blanks');
});

test('the database itself refuses a row that mixes two libraries', () => {
  // Belt and braces: even a query that forgot its library could not do this.
  const db = new Database(DB_PATH);
  try {
    const ids = db.prepare('SELECT id, name FROM libraries').all();
    const beta = ids.find((l) => l.name === 'Beta').id;
    assert.throws(() => db.prepare('INSERT INTO copies (library_id, edition_id) VALUES (?, ?)').run(beta, a.book.edition_id),
      /copies_same_library_ins/);
    assert.throws(() => db.prepare('INSERT INTO shelves (label) VALUES (?)').run('nobody\'s'), /shelves_library_required/);
    assert.throws(() => db.prepare('UPDATE shelves SET library_id = ? WHERE id = ?').run(beta, a.shelf.id), /shelves_library_fixed/);
  } finally {
    db.close();
  }
});

test('Give back is only for a user with their own, verified Open Library keys', async () => {
  // The keys in the environment do not count: with sign-in on, keys are users'.
  assert.equal((await A.get('/api/ol-contributions/status')).status, 403);
  assert.equal((await A.get('/api/account')).data.openlibrary.active, false);

  const wrong = await A.put('/api/account/openlibrary', { access_key: 'nope', secret_key: 'nope' });
  assert.equal(wrong.status, 422, 'keys Open Library refuses are not saved');
  assert.equal((await A.get('/api/account')).data.openlibrary.active, false);

  const saved = await A.put('/api/account/openlibrary', { access_key: GOOD_KEYS.access, secret_key: GOOD_KEYS.secret });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.active, true);
  assert.equal(saved.data.access_hint, '…1234', 'only the end of the access key is ever shown');
  assert.ok(!JSON.stringify((await A.get('/api/account')).data).includes(GOOD_KEYS.secret), 'the secret is never sent back');

  // Stored sealed, not as typed.
  const db = new Database(DB_PATH);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get('alice@gmail.com');
  db.close();
  assert.ok(!JSON.stringify(row).includes(GOOD_KEYS.secret) && !JSON.stringify(row).includes(GOOD_KEYS.access), 'encrypted at rest');

  assert.equal((await A.get('/api/ol-contributions/status')).status, 200, 'now Alice can give back');
  assert.equal((await B.get('/api/ol-contributions/status')).status, 403, 'Bob still cannot: the keys are Alice\'s');

  // Alice's scan fills her library's queue and nobody else's.
  const scan = (await A.post('/api/ol-contributions/scan')).data;
  assert.ok(scan.queued > 0, `the scan proposes gaps: ${JSON.stringify(scan)}`);
  await B.put('/api/account/openlibrary', { access_key: GOOD_KEYS.access, secret_key: GOOD_KEYS.secret });
  assert.deepEqual((await B.get('/api/ol-contributions')).data, [], 'Beta sees none of Alpha\'s proposals');
  const alphaRow = (await A.get('/api/ol-contributions')).data[0];
  assert.equal((await B.post(`/api/ol-contributions/${alphaRow.id}/decline`)).status, 404, 'nor can it act on one');
  assert.equal((await B.get('/api/ol-contributions/status')).data.coverage.checked, 0, 'Beta\'s own coverage only');

  const removed = await A.del('/api/account/openlibrary');
  assert.equal(removed.data.active, false);
  assert.equal((await A.get('/api/ol-contributions/status')).status, 403, 'removing the keys closes it again');
});

test('the page names the signed-in library', async () => {
  const html = (await A.get('/')).data;
  assert.match(html, /📚 Alpha Library/);
  const other = (await B.get('/')).data;
  assert.match(other, /📚 Beta Library/);
});
