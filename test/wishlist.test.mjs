// Wishlists, end to end: the status, the shareable per-user URL, and the
// purchase that must stay a surprise.
//
// The cases that matter are the boundaries. A wishlist page that shows a
// purchase to its owner before the date has spoiled a gift; one that lets a
// book be bought twice has wasted somebody's money; one that edits anything
// was never meant to exist. Each check below fails if the guard were simply
// absent, rather than confirming the happy path twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3251;           // grep `PORT = ` across test/ before picking one
const GOOGLE_PORT = 3252;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/home-library-wishlist-${process.pid}.db`;
const COVERS_DIR = DB_PATH.replace(/\.db$/, '-covers');

const TMP = mkdtempSync(join(tmpdir(), 'home-library-wishlist-'));
const ALLOWED = join(TMP, 'allowed-emails.txt');
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

let server, google;
let nextIdentity = { email: 'alice@gmail.com', email_verified: true };

function idToken(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.signature-not-checked`;
}

test.before(async () => {
  google = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${GOOGLE_PORT}`);
    if (url.pathname === '/auth') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'test-auth-code');
      back.searchParams.set('state', url.searchParams.get('state'));
      res.statusCode = 302;
      res.setHeader('Location', back.toString());
      return res.end();
    }
    if (url.pathname === '/token') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        id_token: idToken({
          aud: CLIENT_ID,
          iss: 'https://accounts.google.com',
          exp: Math.floor(Date.now() / 1000) + 3600,
          ...nextIdentity,
        }),
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => google.listen(GOOGLE_PORT, '127.0.0.1', r));

  writeFileSync(ALLOWED, 'alice@gmail.com\n');
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      COVERS_DIR,
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_AUTH_URL: `http://127.0.0.1:${GOOGLE_PORT}/auth`,
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${GOOGLE_PORT}/token`,
      AUTH_ALLOWED_FILE: ALLOWED,
      SESSION_SECRET: 'test-session-secret',
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
  if (google) await new Promise((r) => google.close(r));
  for (const suffix of ['', '-shm', '-wal']) rmSync(DB_PATH + suffix, { force: true });
  rmSync(COVERS_DIR, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

const cookiesOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);

async function signIn(email, library) {
  nextIdentity = { email, email_verified: true };
  const post = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ to: '/', library }).toString(),
  });
  const flowCookie = cookiesOf(post).join('; ');
  const atGoogle = await fetch(post.headers.get('location'), { redirect: 'manual' });
  const callback = await fetch(atGoogle.headers.get('location'), {
    redirect: 'manual',
    headers: { Cookie: flowCookie },
  });
  assert.equal(callback.status, 302, `${email} gets into ${library}`);
  const session = cookiesOf(callback).find((c) => c.startsWith('hl_session='));
  assert.ok(session, 'a session cookie is set');
  return session;
}

const as = (session) => ({ headers: { Cookie: session, 'Content-Type': 'application/json' } });
const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, opts);
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};

// Today, shifted, as the server's local calendar sees it: the test inherits
// the same TZ as the server it spawned.
function isoDay(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const purchase = (token, bookId, date, session = '') => fetch(`${BASE}/wishlist/${token}/purchase`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(session ? { Cookie: session } : {}) },
  body: new URLSearchParams({ book_id: String(bookId), purchase_date: date }).toString(),
});

let alice, bob;      // sessions
let token;           // alice's wishlist token
let wished, plain;   // alice's books

// ─── the wishlist and its URL ───────────────────────────────────────────────

test('a wishlist book, its per-user token, and the filter that shows only yours', async () => {
  alice = await signIn('alice@gmail.com', 'Bobbalisa');

  wished = (await api('/books', { ...as(alice), method: 'POST', body: JSON.stringify({ title: 'Wished Dragon', status: 'wishlist' }) })).body;
  plain = (await api('/books', { ...as(alice), method: 'POST', body: JSON.stringify({ title: 'Plain Book', status: 'tbr' }) })).body;
  assert.equal(wished.status, 'wishlist');

  const account = (await api('/account', as(alice))).body;
  token = account.wishlist_token;
  assert.match(token, /^[\w-]{20,}$/, 'the account carries a wishlist token');
  const again = (await api('/account', as(alice))).body;
  assert.equal(again.wishlist_token, token, 'the token is stable: the URL gets bookmarked');

  const mine = (await api('/books?status=wishlist', as(alice))).body;
  assert.deepEqual(mine.map((b) => b.title), ['Wished Dragon']);

  // Bob founds his own library; his wishlist is his own, with its own token.
  bob = await signIn('bob@gmail.com', 'Bobs Books');
  const bobAccount = (await api('/account', as(bob))).body;
  assert.ok(bobAccount.wishlist_token, 'every user gets a token');
  assert.notEqual(bobAccount.wishlist_token, token, 'and not the same one');
  const bobsList = await fetch(`${BASE}/wishlist/${bobAccount.wishlist_token}`);
  assert.doesNotMatch(await bobsList.text(), /Wished Dragon/, "alice's wishes are not on bob's list");
});

test('anyone holding the URL may look, and only look', async () => {
  const page = await fetch(`${BASE}/wishlist/${token}`);
  assert.equal(page.status, 200, 'no sign-in needed');
  const html = await page.text();
  assert.match(html, /Wished Dragon/);
  assert.doesNotMatch(html, /Plain Book/, 'only wishlist books are on the page');
  assert.doesNotMatch(html, /Purchase<\/summary>/, 'a stranger gets no purchase button');
  assert.match(html, /auth\/login/, 'but is told signing in earns one');

  assert.equal((await fetch(`${BASE}/wishlist/not-a-real-token`)).status, 404);
  const anon = await purchase(token, wished.id, isoDay(1));
  assert.equal(anon.status, 401, 'a purchase needs a signed-in identity');
});

// ─── buying ─────────────────────────────────────────────────────────────────

test('a signed-in visitor may buy a book once; the owner may not buy at all', async () => {
  const own = await purchase(token, wished.id, isoDay(1), alice);
  assert.equal(own.status, 403, 'your own wishlist is for other people');

  const asBob = await fetch(`${BASE}/wishlist/${token}`, { headers: { Cookie: bob } });
  assert.match(await asBob.text(), /Purchase<\/summary>/, 'a signed-in visitor gets the button');

  const bad = await purchase(token, wished.id, 'next tuesday', bob);
  assert.equal(bad.status, 400, 'the date must be a date');
  const missing = await purchase(token, plain.id, isoDay(1), bob);
  assert.equal(missing.status, 404, 'a book not on the wishlist cannot be bought through it');

  const bought = await purchase(token, wished.id, isoDay(1), bob);
  assert.equal(bought.status, 303, 'the purchase lands and returns to the page');

  const after = await (await fetch(`${BASE}/wishlist/${token}`, { headers: { Cookie: bob } })).text();
  assert.match(after, /Purchased by bob@gmail\.com on /, 'the record replaces the button');
  assert.doesNotMatch(after, /Purchase<\/summary>/);

  const twice = await purchase(token, wished.id, isoDay(2), bob);
  assert.equal(twice.status, 409, 'a book is bought once');
});

test('the purchase is a surprise: hidden from the owner until its date has passed', async () => {
  // In the API the owner uses every day…
  const hidden = (await api(`/books/${wished.id}`, as(alice))).body;
  assert.equal(hidden.purchased_by, null, 'the buyer is withheld from the owner');
  assert.equal(hidden.purchase_date, null, 'and so is the date');

  // …and on the public page, even signed in as themselves.
  const ownPage = await (await fetch(`${BASE}/wishlist/${token}`, { headers: { Cookie: alice } })).text();
  assert.doesNotMatch(ownPage, /bob@gmail\.com/, 'the owner sees no purchase on the page either');

  // A stranger with the URL learns the book is taken, but not by whom: the
  // address travels further than anyone controls.
  const anonPage = await (await fetch(`${BASE}/wishlist/${token}`)).text();
  assert.match(anonPage, /Spoken for/);
  assert.doesNotMatch(anonPage, /bob@gmail\.com/);

  // Time passes. Backdate the purchase in the database rather than waiting a day.
  const db = new Database(DB_PATH);
  db.prepare('UPDATE copies SET purchase_date = ? WHERE id = ?').run(isoDay(-1), wished.id);
  db.close();

  const shown = (await api(`/books/${wished.id}`, as(alice))).body;
  assert.equal(shown.purchased_by, 'bob@gmail.com', 'past its date, the owner is told');
  assert.equal(shown.purchase_date, isoDay(-1));
});

test('leaving the wishlist retires the entry, purchase and all', async () => {
  const updated = (await api(`/books/${wished.id}`, {
    ...as(alice), method: 'PUT', body: JSON.stringify({ status: 'tbr' }),
  })).body;
  assert.equal(updated.status, 'tbr');
  assert.equal(updated.purchased_by, null);
  assert.equal(updated.purchase_date, null);

  const page = await (await fetch(`${BASE}/wishlist/${token}`)).text();
  assert.doesNotMatch(page, /Wished Dragon/, 'off the wishlist, off the page');

  // Back on: a fresh wish, not a resurrected purchase that would block buyers.
  const rewished = (await api(`/books/${wished.id}`, {
    ...as(alice), method: 'PUT', body: JSON.stringify({ status: 'wishlist' }),
  })).body;
  assert.equal(rewished.purchased_by, null);
  const asBob = await (await fetch(`${BASE}/wishlist/${token}`, { headers: { Cookie: bob } })).text();
  assert.match(asBob, /Purchase<\/summary>/, 'the book can be bought again');
});
