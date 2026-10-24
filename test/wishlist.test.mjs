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

const purchase = (path, bookId, date, session = '') => fetch(`${BASE}/${path}/purchase`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(session ? { Cookie: session } : {}) },
  body: new URLSearchParams({ book_id: String(bookId), purchase_date: date }).toString(),
});

let alice, bob;      // sessions
let path;            // alice's wishlist path: wishlist/<library>/<email>
let wished, plain;   // alice's books

// ─── the wishlist and its URL ───────────────────────────────────────────────

test('a wishlist book, its readable per-user address, and the filter that shows only yours', async () => {
  alice = await signIn('alice@gmail.com', 'Bobbalisa');

  wished = (await api('/books', { ...as(alice), method: 'POST', body: JSON.stringify({ title: 'Wished Dragon', status: 'wishlist' }) })).body;
  plain = (await api('/books', { ...as(alice), method: 'POST', body: JSON.stringify({ title: 'Plain Book', status: 'tbr' }) })).body;
  assert.equal(wished.status, 'wishlist');

  // The address names the library and the person, forced to lower-case for
  // sharing even though both are stored case-preserved ("Bobbalisa").
  const account = (await api('/account', as(alice))).body;
  path = account.wishlist_path;
  assert.equal(path, 'wishlist/bobbalisa/alice%40gmail.com');

  // …and matches case-insensitively: every casing is the same page.
  for (const spelling of [path, 'wishlist/BobBalisa/Alice@Gmail.COM']) {
    const r = await fetch(`${BASE}/${spelling}`);
    assert.equal(r.status, 200, `${spelling} finds the page`);
    assert.match(await r.text(), /Wished Dragon/);
  }

  const mine = (await api('/books?status=wishlist', as(alice))).body;
  assert.deepEqual(mine.map((b) => b.title), ['Wished Dragon']);

  // Bob founds his own library; his wishlist is his own, at its own address.
  bob = await signIn('bob@gmail.com', 'Bobs Books');
  const bobAccount = (await api('/account', as(bob))).body;
  assert.equal(bobAccount.wishlist_path, 'wishlist/bobs%20books/bob%40gmail.com');
  const bobsList = await fetch(`${BASE}/${bobAccount.wishlist_path}`);
  assert.doesNotMatch(await bobsList.text(), /Wished Dragon/, "alice's wishes are not on bob's list");

  // An address must name a member OF that library: bob is not in Bobbalisa
  // (alice, user 1, is the server's owner and so a member of every library,
  // bob's included), and a library that does not exist holds nobody's wishes.
  assert.equal((await fetch(`${BASE}/wishlist/bobbalisa/bob@gmail.com`)).status, 404);
  assert.equal((await fetch(`${BASE}/wishlist/no-such-library/alice@gmail.com`)).status, 404);
});

test("status is each member's own: one copy, two readers, two truths", async () => {
  // Alice (user 1, the owner-founder) lets carol into the same library.
  const added = await api('/library/members', {
    ...as(alice), method: 'POST', body: JSON.stringify({ email: 'carol@gmail.com' }),
  });
  assert.equal(added.status, 201);
  const carol = await signIn('carol@gmail.com', 'Bobbalisa');

  // Alice's wish is not carol's: the same copy reads as untouched for her.
  const hers = (await api(`/books/${wished.id}`, as(carol))).body;
  assert.equal(hers.status, 'tbr', "alice's wishlist book is plain 'tbr' to carol");
  assert.deepEqual((await api('/books?status=wishlist', as(carol))).body, [],
    "the wishlist filter shows carol's empty wishlist, not alice's");

  // Carol reads the other book; alice's copy of the truth is unmoved.
  const read = (await api(`/books/${plain.id}`, {
    ...as(carol), method: 'PUT', body: JSON.stringify({ status: 'read' }),
  })).body;
  assert.equal(read.status, 'read', 'carol has read it');
  assert.equal((await api(`/books/${plain.id}`, as(alice))).body.status, 'tbr',
    'alice has not, and carol finishing it does not change that');

  // Carol retitling the wished book edits shared edition data, but the status
  // she sends along is HER status: alice's wish survives other people's tidying.
  await api(`/books/${wished.id}`, {
    ...as(carol), method: 'PUT', body: JSON.stringify({ title: 'Wished Dragon', status: 'tbr' }),
  });
  assert.equal((await api(`/books/${wished.id}`, as(alice))).body.status, 'wishlist',
    "another member's edit cannot take a book off alice's wishlist");
});

test('anyone holding the URL may look — and a stranger’s Purchase button leads through sign-in', async () => {
  const page = await fetch(`${BASE}/${path}`);
  assert.equal(page.status, 200, 'no sign-in needed');
  const html = await page.text();
  assert.match(html, /Wished Dragon/);
  assert.doesNotMatch(html, /Plain Book/, 'only wishlist books are on the page');
  assert.doesNotMatch(html, /Purchase<\/summary>/, 'a stranger gets no date form');
  // The stranger's Purchase button is a sign-in link that comes back to this
  // page with the book marked (?buy=), where the date form will be open.
  const buy = html.match(/class="buy-link" href="([^"]+)"/);
  assert.ok(buy, 'a stranger sees the Purchase button');
  assert.match(buy[1], /auth\/login\?to=/, 'it leads through sign-in');
  assert.match(decodeURIComponent(buy[1]), new RegExp(`\\?buy=${wished.id}`), 'and remembers which book');

  // A bare library path is the ANONYMOUS user's wishlist, which a server with
  // sign-in configured does not have.
  assert.equal((await fetch(`${BASE}/wishlist/bobbalisa`)).status, 404);
  const anon = await purchase(path, wished.id, isoDay(1));
  assert.equal(anon.status, 401, 'a purchase needs a signed-in identity');
});

// ─── buying ─────────────────────────────────────────────────────────────────

test('signing in from the Purchase button opens that book’s date form; refusing returns to the list', async () => {
  // Signed in and arriving with ?buy=<id>, the fold is already open: the
  // person is being asked for the purchase date, nothing more.
  const cont = await (await fetch(`${BASE}/${path}?buy=${wished.id}`, { headers: { Cookie: bob } })).text();
  assert.match(cont, /<details class="buy" open>/, 'the date form is open');

  // Refusing at Google's consent screen lands back on the wishlist, with no
  // session and nothing purchased: start a login aimed at the wishlist, then
  // finish it with error= instead of a code.
  const to = `/${path}?buy=${wished.id}`;
  const post = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ to, library: 'Bobbalisa' }).toString(),
  });
  const flowCookie = cookiesOf(post).join('; ');
  const state = new URL(post.headers.get('location')).searchParams.get('state');
  const refused = await fetch(`${BASE}/auth/callback?state=${encodeURIComponent(state)}&error=access_denied`, {
    redirect: 'manual',
    headers: { Cookie: flowCookie },
  });
  assert.equal(refused.status, 303, 'a refusal is a redirect, not an error page');
  assert.equal(refused.headers.get('location'), to, 'back to the wishlist it came from');
  assert.equal(cookiesOf(refused).some((c) => c.startsWith('hl_session=') && !c.includes('hl_session=;')), false,
    'and no session was minted');
  const after = (await api(`/books/${wished.id}`, as(alice))).body;
  assert.equal(after.purchased_by, null, 'nothing was purchased');
});

test('a signed-in visitor may buy a book once; the owner may not buy at all', async () => {
  const own = await purchase(path, wished.id, isoDay(1), alice);
  assert.equal(own.status, 403, 'your own wishlist is for other people');

  const asBob = await fetch(`${BASE}/${path}`, { headers: { Cookie: bob } });
  assert.match(await asBob.text(), /Purchase<\/summary>/, 'a signed-in visitor gets the button');

  const bad = await purchase(path, wished.id, 'next tuesday', bob);
  assert.equal(bad.status, 400, 'the date must be a date');
  const missing = await purchase(path, plain.id, isoDay(1), bob);
  assert.equal(missing.status, 404, 'a book not on the wishlist cannot be bought through it');

  const bought = await purchase(path, wished.id, isoDay(1), bob);
  assert.equal(bought.status, 303, 'the purchase lands and returns to the page');

  const after = await (await fetch(`${BASE}/${path}`, { headers: { Cookie: bob } })).text();
  assert.match(after, /Purchased by bob@gmail\.com on /, 'the record replaces the button');
  assert.doesNotMatch(after, /Purchase<\/summary>/);

  const twice = await purchase(path, wished.id, isoDay(2), bob);
  assert.equal(twice.status, 409, 'a book is bought once');
});

test('the purchase is a surprise: hidden from the owner until its date has passed', async () => {
  // In the API the owner uses every day…
  const hidden = (await api(`/books/${wished.id}`, as(alice))).body;
  assert.equal(hidden.purchased_by, null, 'the buyer is withheld from the owner');
  assert.equal(hidden.purchase_date, null, 'and so is the date');

  // …and on the public page, even signed in as themselves.
  const ownPage = await (await fetch(`${BASE}/${path}`, { headers: { Cookie: alice } })).text();
  assert.doesNotMatch(ownPage, /bob@gmail\.com/, 'the owner sees no purchase on the page either');

  // A stranger with the URL learns the book is taken, but not by whom: the
  // address travels further than anyone controls.
  const anonPage = await (await fetch(`${BASE}/${path}`)).text();
  assert.match(anonPage, /Spoken for/);
  assert.doesNotMatch(anonPage, /bob@gmail\.com/);

  // Time passes. Backdate the purchase in the database rather than waiting a
  // day. It lives on the wisher's own status row — statuses are per user.
  const db = new Database(DB_PATH);
  db.prepare('UPDATE user_statuses SET purchase_date = ? WHERE copy_id = ?').run(isoDay(-1), wished.id);
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

  const page = await (await fetch(`${BASE}/${path}`)).text();
  assert.doesNotMatch(page, /Wished Dragon/, 'off the wishlist, off the page');

  // Back on: a fresh wish, not a resurrected purchase that would block buyers.
  const rewished = (await api(`/books/${wished.id}`, {
    ...as(alice), method: 'PUT', body: JSON.stringify({ status: 'wishlist' }),
  })).body;
  assert.equal(rewished.purchased_by, null);
  const asBob = await (await fetch(`${BASE}/${path}`, { headers: { Cookie: bob } })).text();
  assert.match(asBob, /Purchase<\/summary>/, 'the book can be bought again');
});
