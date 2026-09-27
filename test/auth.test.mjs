// Who gets in, end to end.
//
// A stub stands in for Google: the flow is a redirect and a form POST, both of
// which a local server can play convincingly, and a test suite has no business
// holding real OAuth credentials.
//
// The important cases here are the negative ones. An allowlist that lets the
// wrong person in fails silently — the app works, for somebody it should not
// have worked for — so each check below is written to fail if the gate were
// simply absent, rather than to confirm that the happy path still opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCookies, sessionFor, sessionIdleDays, sessionNeedsRefresh } from '../auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3217;
const GOOGLE_PORT = 3218;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/home-library-auth-${process.pid}.db`;
const COVERS_DIR = DB_PATH.replace(/\.db$/, '-covers');

const TMP = mkdtempSync(join(tmpdir(), 'home-library-auth-'));
const ALLOWED = join(TMP, 'allowed-emails.txt');

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
// Same secret the server is started with, so this process can mint a session
// the server will accept — which is how the sliding window is tested without
// waiting five days for one to age.
process.env.SESSION_SECRET = 'test-session-secret';

let server, google;
// What the stub's token endpoint will claim the signed-in person is.
let nextIdentity = { email: 'owner@gmail.com', email_verified: true };
let lastAuthRequest = null;

// An id_token is three dot-separated base64url parts. Only the middle one is
// read (see auth.js on why the signature is not checked), so the stub signs
// nothing — which also means a test cannot accidentally depend on it.
function idToken(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.signature-not-checked`;
}

test.before(async () => {
  google = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${GOOGLE_PORT}`);
    if (url.pathname === '/auth') {
      // Google would show a password prompt here; the stub sends the browser
      // straight back with a code, which is the only part the app sees.
      lastAuthRequest = url;
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

  // The allowlist as it was before users were rows. The first start turns it
  // into the members of the first library, Bobbalisa.
  writeFileSync(ALLOWED, '# the household\nOwner@Gmail.com\n');
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
    // /auth/me is the one route that answers before anybody has signed in.
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

// Walk the whole flow the way a browser would, carrying cookies by hand: the
// form, its POST naming a library, Google, and back. Returns the callback's
// response and every cookie set along the way.
const cookiesOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);

async function signIn(to = '/', library = 'Bobbalisa', cookie = '') {
  const form = await fetch(`${BASE}/auth/login?to=${encodeURIComponent(to)}`, { headers: { Cookie: cookie } });
  assert.equal(form.status, 200, 'the sign-in form is a page');
  const post = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ to, library }).toString(),
  });
  assert.equal(post.status, 303, 'submitting the form goes to Google');
  const flowCookie = cookiesOf(post).join('; ');

  const atGoogle = await fetch(post.headers.get('location'), { redirect: 'manual' });
  const callback = await fetch(atGoogle.headers.get('location'), {
    redirect: 'manual',
    headers: { Cookie: flowCookie },
  });
  return { callback, setCookies: callback.headers.getSetCookie?.() ?? [] };
}

const sessionFrom = (setCookies) => setCookies
  .map((c) => c.split(';')[0])
  .find((c) => c.startsWith('hl_session='));
const lastFrom = (setCookies) => setCookies
  .map((c) => c.split(';')[0])
  .find((c) => c.startsWith('hl_last='));

const as = (session) => ({ headers: { Cookie: session, 'Content-Type': 'application/json' } });

// ─── the gate ───────────────────────────────────────────────────────────────

test('nothing is served to a browser that has not signed in', async () => {
  const api = await fetch(`${BASE}/api/books`);
  assert.equal(api.status, 401, 'the API refuses rather than redirecting into Google');
  const body = await api.json();
  assert.match(body.login, /\/auth\/login$/, 'and says where to sign in');

  const page = await fetch(`${BASE}/`, { redirect: 'manual', headers: { Accept: 'text/html' } });
  assert.equal(page.status, 302, 'a page request goes to the sign-in flow');
  assert.match(page.headers.get('location'), /\/auth\/login\?to=/);

  // A cookie nobody signed is not a session, however well-formed it looks.
  const forged = await fetch(`${BASE}/api/books`, {
    headers: { Cookie: `hl_session=${Buffer.from(JSON.stringify({ email: 'owner@gmail.com', exp: Date.now() + 1e6 })).toString('base64url')}.not-a-real-signature` },
  });
  assert.equal(forged.status, 401, 'an unsigned session is refused');
});

test('signing in with Google opens the app, and signing out closes it again', async () => {
  nextIdentity = { email: 'owner@gmail.com', email_verified: true };
  const { callback, setCookies } = await signIn('/api/books');
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/api/books', 'you land back where you were sent from');

  // The request to Google asked for the things that make the reply trustworthy.
  assert.equal(lastAuthRequest.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(lastAuthRequest.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(lastAuthRequest.searchParams.get('state'), 'a state parameter is sent');
  assert.match(lastAuthRequest.searchParams.get('redirect_uri'), /\/auth\/callback$/);

  const session = sessionFrom(setCookies);
  assert.ok(session, 'a session cookie is set');
  const attrs = setCookies.find((c) => c.startsWith('hl_session='));
  assert.match(attrs, /HttpOnly/i, 'the session cookie is not readable from JavaScript');
  assert.match(attrs, /SameSite=Lax/i);

  const ok = await fetch(`${BASE}/api/books`, { headers: { Cookie: session } });
  assert.equal(ok.status, 200, 'the API answers a signed-in request');

  const me = await (await fetch(`${BASE}/auth/me`, { headers: { Cookie: session } })).json();
  assert.deepEqual(me, {
    required: true,
    email: 'owner@gmail.com',
    library: { id: 1, name: 'Bobbalisa', display: 'Bobbalisa Library' },
  });

  // The header says whose library this is, in the page and in the tab title.
  const html = await (await fetch(`${BASE}/`, { headers: { Cookie: session } })).text();
  assert.match(html, /📚 Bobbalisa Library/);
  assert.match(html, /<title>Bobbalisa Library /);

  const out = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { Cookie: session }, redirect: 'manual' });
  assert.match(out.headers.getSetCookie().join(';'), /hl_session=;/, 'signing out clears the cookie');
  assert.doesNotMatch(out.headers.getSetCookie().join(';'), /hl_last=;/, 'but not the remembered sign-in');
  assert.match(out.headers.get('location'), /\/auth\/login$/, 'and goes back to the form');
});

test('a callback nobody started is refused', async () => {
  // The state cookie is what proves this browser began the flow. Without it,
  // this is somebody else's login being finished here.
  const bare = await fetch(`${BASE}/auth/callback?code=test-auth-code&state=whatever`, { redirect: 'manual' });
  assert.equal(bare.status, 400);
  assert.equal(sessionFrom(bare.headers.getSetCookie?.() ?? []), undefined, 'and sets no session');

  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'library=Bobbalisa',
  });
  const flowCookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const wrongState = await fetch(`${BASE}/auth/callback?code=test-auth-code&state=not-the-one`, {
    redirect: 'manual', headers: { Cookie: flowCookie },
  });
  assert.equal(wrongState.status, 400, 'a state that does not match the cookie is refused');
});

test('the allowlist file became the first library\'s members, and nobody else gets in', async () => {
  nextIdentity = { email: 'owner@gmail.com', email_verified: true };
  const owner = await signIn('/', 'bobbalisa');
  assert.ok(sessionFrom(owner.setCookies), 'the address from the file is a member; the name is matched ignoring case');

  nextIdentity = { email: 'stranger@gmail.com', email_verified: true };
  const refused = await signIn('/', 'Bobbalisa');
  assert.equal(refused.callback.status, 403, 'an existing library admits its members and nobody else');
  const page = await refused.callback.text();
  assert.match(page, /stranger@gmail\.com/, 'the refusal names the address that was tried');
  assert.match(page, /Bobbalisa Library/, 'and the library');
  assert.equal(sessionFrom(refused.setCookies), undefined, 'no session is issued');
  nextIdentity = { email: 'owner@gmail.com', email_verified: true };
});

test('naming an unused library creates it, with only the person signing in', async () => {
  nextIdentity = { email: 'founder@gmail.com', email_verified: true };
  const made = await signIn('/', '  The   Reading Room  ');
  const session = sessionFrom(made.setCookies);
  assert.ok(session, 'the founder is signed in to the new library');
  const me = await (await fetch(`${BASE}/auth/me`, { headers: { Cookie: session } })).json();
  assert.equal(me.library.name, 'The Reading Room', 'whitespace is tidied, case kept');
  assert.equal(me.library.display, 'The Reading Room Library', 'shown with " Library" after it');
  const mine = await (await fetch(`${BASE}/api/library/members`, as(session))).json();
  assert.deepEqual(mine.map((m) => m.email), ['founder@gmail.com'], 'its only member');
  const genres = await (await fetch(`${BASE}/api/genres`, as(session))).json();
  assert.ok(genres.length > 10, 'it starts with the stock genres, its own copy');

  nextIdentity = { email: 'owner@gmail.com', email_verified: true };
  const other = await signIn('/', 'the reading room');
  assert.equal(other.callback.status, 403, 'a second person naming it is not a founder, just a non-member');
});

test('a member added from the Members screen gets in, and loses access when removed', async () => {
  nextIdentity = { email: 'keeper@gmail.com', email_verified: true };
  const keeper = sessionFrom((await signIn('/', 'Keepers Hall')).setCookies);

  const added = await fetch(`${BASE}/api/library/members`, { method: 'POST', ...as(keeper), body: JSON.stringify({ email: 'Guest@Gmail.com' }) });
  assert.equal(added.status, 201);
  const bad = await fetch(`${BASE}/api/library/members`, { method: 'POST', ...as(keeper), body: JSON.stringify({ email: 'not an address' }) });
  assert.equal(bad.status, 400, 'a typo is caught');

  nextIdentity = { email: 'guest@gmail.com', email_verified: true };
  const guest = sessionFrom((await signIn('/', 'Keepers Hall')).setCookies);
  assert.ok(guest, 'the added address can now sign in');
  assert.equal((await fetch(`${BASE}/api/books`, as(guest))).status, 200);

  const list = await (await fetch(`${BASE}/api/library/members`, as(keeper))).json();
  const guestRow = list.find((m) => m.email === 'guest@gmail.com');
  const keeperRow = list.find((m) => m.email === 'keeper@gmail.com');
  assert.equal(guestRow.added_by, 'keeper@gmail.com', 'who added whom is kept');
  assert.equal(keeperRow.you, true);

  const self = await fetch(`${BASE}/api/library/members/${keeperRow.id}`, { method: 'DELETE', ...as(keeper) });
  assert.equal(self.status, 409, 'nobody removes themselves');

  const removed = await fetch(`${BASE}/api/library/members/${guestRow.id}`, { method: 'DELETE', ...as(keeper) });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${BASE}/api/books`, as(guest))).status, 401, 'the removed member is out on their next request');

  // The last member cannot be removed by anyone: it would strand the library.
  const onlyOne = await fetch(`${BASE}/api/library/members/${keeperRow.id}`, { method: 'DELETE', ...as(guest) });
  assert.equal(onlyOne.status, 401, 'and a non-member cannot even ask');
  nextIdentity = { email: 'owner@gmail.com', email_verified: true };
});

test('the sign-in form remembers who signed in last, and to which library', async () => {
  nextIdentity = { email: 'owner@gmail.com', email_verified: true };
  const first = await signIn('/', 'Bobbalisa');
  const last = lastFrom(first.setCookies);
  assert.ok(last, 'signing in leaves a remembered sign-in');
  assert.match(first.setCookies.find((c) => c.startsWith('hl_last=')), /HttpOnly/i);

  const form = await (await fetch(`${BASE}/auth/login`, { headers: { Cookie: last } })).text();
  assert.match(form, /name="library"[^>]*value="Bobbalisa"/, 'the library is filled in');
  assert.match(form, /owner@gmail\.com/, 'and the address is shown');

  await signIn('/', 'Bobbalisa', last);
  assert.equal(lastAuthRequest.searchParams.get('login_hint'), 'owner@gmail.com', 'Google is offered the same account first');

  const blank = await fetch(`${BASE}/auth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `library=${'x'.repeat(61)}`,
  });
  assert.equal(blank.status, 400, 'a name that is too long is refused at the form');
});

test('a session from before libraries carries its member across', async () => {
  // Minted the old way: no library in it. The owner belongs to one library, so
  // that is the one it meant, and the refreshed cookie now says so.
  const legacy = `hl_session=${sessionFor('owner@gmail.com')}`;
  const r = await fetch(`${BASE}/api/books`, { headers: { Cookie: legacy } });
  assert.equal(r.status, 200);
  const upgraded = sessionFrom(r.headers.getSetCookie?.() ?? []);
  assert.ok(upgraded, 'the session is re-issued');
  const payload = JSON.parse(Buffer.from(upgraded.split('=')[1].split('.')[0], 'base64url'));
  assert.equal(payload.lib, 1, 'naming the library');
});

test('an unverified Google address is not an identity', async () => {
  // Anyone can put somebody else's address on an account they just made; only
  // Google saying it verified it makes the claim worth anything.
  nextIdentity = { email: 'owner@gmail.com', email_verified: false };
  const { callback, setCookies } = await signIn();
  assert.equal(callback.status, 502, 'the sign-in does not complete');
  assert.equal(sessionFrom(setCookies), undefined, 'and no session is issued');
  nextIdentity = { email: 'owner@gmail.com', email_verified: true };
});

// The regression that took the site down: the failover script claims the VIP
// only when the app answers 200, and it had been asking for a page that sign-in
// turned into a 401. A healthy node looked dead, so the VIP was never assigned
// and its tailnet route was withdrawn with it.
test('the health probe answers without an account', async () => {
  const r = await fetch(`${BASE}/healthz`);
  assert.equal(r.status, 200, 'a probe carries no identity and must not be refused');
  assert.equal(await r.text(), 'ok');

  // It must not be a hole in the gate either: only this one path is open.
  for (const path of ['/api/books', '/api/meta', '/', '/healthz/../api/books']) {
    const gated = await fetch(BASE + path, { redirect: 'manual' });
    assert.notEqual(gated.status, 200, `${path} is still behind the gate`);
  }
});

// The manifest is fetched without the session cookie, so behind the gate it
// was a 401 for everyone and the app could not be added to a home screen.
test('the manifest and its icons load without an account', async () => {
  const r = await fetch(`${BASE}/manifest.webmanifest`);
  assert.equal(r.status, 200, 'a browser sends no cookie for the manifest');
  const manifest = await r.json();
  for (const icon of manifest.icons) {
    const i = await fetch(`${BASE}/${icon.src}`);
    assert.equal(i.status, 200, `${icon.src} is fetched with no cookie when the app is installed`);
  }

  // Only those files: the rest of public/ stays behind the gate.
  for (const path of ['/app.js', '/styles.css', '/index.html', '/manifest.webmanifest/../app.js']) {
    const gated = await fetch(BASE + path, { redirect: 'manual' });
    assert.notEqual(gated.status, 200, `${path} is still behind the gate`);
  }
});

// ─── how long a session lasts ───────────────────────────────────────────────

test('a day count that is not a number falls back rather than never expiring', () => {
  const saved = process.env.SESSION_IDLE_DAYS;
  try {
    for (const [set, want] of [[undefined, 10], ['', 10], ['  ', 10], ['7', 7], ['0', 1], ['-3', 1],
                               ['10d', 10], ['thirty', 10], ['NaN', 10]]) {
      if (set === undefined) delete process.env.SESSION_IDLE_DAYS;
      else process.env.SESSION_IDLE_DAYS = set;
      assert.equal(sessionIdleDays(), want, `SESSION_IDLE_DAYS=${JSON.stringify(set)}`);
    }
    // The bug this guards: Number('10d') is NaN, and NaN < Date.now() is false,
    // so an unguarded expiry check accepts such a session for ever.
    delete process.env.SESSION_IDLE_DAYS;
    const exp = JSON.parse(Buffer.from(sessionFor('owner@gmail.com').split('.')[0], 'base64url'));
    assert.ok(Number.isFinite(exp.exp), 'the expiry stamped into a session is a real number');
  } finally {
    if (saved === undefined) delete process.env.SESSION_IDLE_DAYS;
    else process.env.SESSION_IDLE_DAYS = saved;
  }
});

test('a session is refreshed only once it is past its half-life', () => {
  const now = Date.UTC(2026, 0, 1);
  const day = 24 * 3600 * 1000;
  const at = (daysLeft) => sessionNeedsRefresh({ exp: now + daysLeft * day }, now, 10 * day);
  assert.equal(at(10), false, 'just issued: nothing to do');
  assert.equal(at(6), false, 'four days in: still more than half left');
  assert.equal(at(4), true, 'six days in: past the half-life, push it out');
  assert.equal(at(0.5), true);
  assert.equal(sessionNeedsRefresh(null, now, 10 * day), false);
});

test('visiting slides the window, so a regular visitor never signs in again', async () => {
  // A valid session with only a day left on it: minted here with a one-day
  // window, handed to a server running the default ten-day one, which therefore
  // sees it as well past its half-life.
  process.env.SESSION_IDLE_DAYS = '1';
  const nearlyExpired = `hl_session=${sessionFor('owner@gmail.com', 1)}`;
  delete process.env.SESSION_IDLE_DAYS;

  const used = await fetch(`${BASE}/api/books`, { headers: { Cookie: nearlyExpired } });
  assert.equal(used.status, 200, 'it still works');
  const reissued = sessionFrom(used.headers.getSetCookie?.() ?? []);
  assert.ok(reissued, 'and the visit hands back a fresh cookie');
  assert.notEqual(reissued, nearlyExpired, 'a new one, not the same one echoed back');

  // The refreshed cookie is good for the full window again.
  const payload = JSON.parse(Buffer.from(reissued.split('=')[1].split('.')[0], 'base64url'));
  const daysLeft = (payload.exp - Date.now()) / (24 * 3600 * 1000);
  assert.ok(daysLeft > 9.9 && daysLeft <= 10, `pushed out to the full window, got ${daysLeft}`);

  // A session nowhere near expiry is left alone, so ordinary browsing does not
  // put a Set-Cookie on every asset.
  const fresh = sessionFrom((await signIn()).setCookies);
  const again = await fetch(`${BASE}/api/books`, { headers: { Cookie: fresh } });
  assert.equal(again.status, 200);
  assert.equal(sessionFrom(again.headers.getSetCookie?.() ?? []), undefined,
    'a fresh session is not re-issued on every request');
});

test('cookie parsing survives the shapes a browser actually sends', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('flag; a=1'), { a: '1' }, 'a valueless cookie is skipped, not fatal');
  assert.deepEqual(parseCookies('a=one%20two'), { a: 'one two' });
});
