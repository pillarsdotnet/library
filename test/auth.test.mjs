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
import { emailAllowed, readAllowlist, parseCookies } from '../auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3217;
const GOOGLE_PORT = 3218;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/home-library-auth-${process.pid}.db`;
const COVERS_DIR = DB_PATH.replace(/\.db$/, '-covers');

const TMP = mkdtempSync(join(tmpdir(), 'home-library-auth-'));
const ALLOWED = join(TMP, 'allowed-emails.txt');

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

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

  writeFileSync(ALLOWED, '');
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

// Walk the whole flow the way a browser would, carrying cookies by hand, and
// return the session cookie it ends up holding.
async function signIn(to = '/') {
  const login = await fetch(`${BASE}/auth/login?to=${encodeURIComponent(to)}`, { redirect: 'manual' });
  assert.equal(login.status, 302, 'login starts a redirect');
  const flowCookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).join('; ');

  const atGoogle = await fetch(login.headers.get('location'), { redirect: 'manual' });
  const callback = await fetch(atGoogle.headers.get('location'), {
    redirect: 'manual',
    headers: { Cookie: flowCookie },
  });
  return { callback, setCookies: callback.headers.getSetCookie?.() ?? [] };
}

const sessionFrom = (setCookies) => setCookies
  .map((c) => c.split(';')[0])
  .find((c) => c.startsWith('hl_session='));

// ─── the allowlist, read directly ───────────────────────────────────────────

test('an absent or empty allowlist admits every signed-in address', () => {
  const missing = join(TMP, 'does-not-exist.txt');
  assert.equal(readAllowlist(missing).present, false);
  assert.equal(emailAllowed('anybody@gmail.com', missing), true, 'absent file: no further restriction');

  const empty = join(TMP, 'empty.txt');
  writeFileSync(empty, '\n\n   \n# only a comment\n');
  assert.deepEqual(readAllowlist(empty).entries, [], 'comments and blank lines are not entries');
  assert.equal(emailAllowed('anybody@gmail.com', empty), true, 'empty file: no further restriction');
});

test('a populated allowlist admits only the addresses on it', () => {
  const file = join(TMP, 'list.txt');
  writeFileSync(file, '# the household\nOwner@Gmail.com\n  second@gmail.com  # the other phone\n');
  assert.equal(emailAllowed('owner@gmail.com', file), true, 'case does not matter');
  assert.equal(emailAllowed('second@gmail.com', file), true, 'a trailing comment is not part of the address');
  assert.equal(emailAllowed('stranger@gmail.com', file), false, 'everybody else is refused');
  assert.equal(emailAllowed('', file), false);
  assert.equal(emailAllowed(undefined, file), false);
});

test('an edited allowlist is picked up without a restart', () => {
  const file = join(TMP, 'edited.txt');
  writeFileSync(file, 'owner@gmail.com\n');
  assert.equal(emailAllowed('later@gmail.com', file), false);
  writeFileSync(file, 'owner@gmail.com\nlater@gmail.com\n');
  assert.equal(emailAllowed('later@gmail.com', file), true, 'the file is re-read when it changes');
});

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
  assert.deepEqual(me, { required: true, email: 'owner@gmail.com' });

  const out = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { Cookie: session }, redirect: 'manual' });
  assert.match(out.headers.getSetCookie().join(';'), /hl_session=;/, 'signing out clears the cookie');
});

test('a callback nobody started is refused', async () => {
  // The state cookie is what proves this browser began the flow. Without it,
  // this is somebody else's login being finished here.
  const bare = await fetch(`${BASE}/auth/callback?code=test-auth-code&state=whatever`, { redirect: 'manual' });
  assert.equal(bare.status, 400);
  assert.equal(sessionFrom(bare.headers.getSetCookie?.() ?? []), undefined, 'and sets no session');

  const login = await fetch(`${BASE}/auth/login`, { redirect: 'manual' });
  const flowCookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const wrongState = await fetch(`${BASE}/auth/callback?code=test-auth-code&state=not-the-one`, {
    redirect: 'manual', headers: { Cookie: flowCookie },
  });
  assert.equal(wrongState.status, 400, 'a state that does not match the cookie is refused');
});

test('an address not on the allowlist is turned away, and loses a session it already had', async () => {
  nextIdentity = { email: 'stranger@gmail.com', email_verified: true };
  const open = await signIn();
  const session = sessionFrom(open.setCookies);
  assert.ok(session, 'with an empty allowlist the stranger gets in');

  // Now name somebody else, and only somebody else.
  writeFileSync(ALLOWED, '# just the one account\nowner@gmail.com\n');
  const shut = await fetch(`${BASE}/api/books`, { headers: { Cookie: session } });
  assert.equal(shut.status, 401, 'the session stops working the moment the file changes');

  const refused = await signIn();
  assert.equal(refused.callback.status, 403, 'and signing in again is refused outright');
  assert.match(await refused.callback.text(), /stranger@gmail\.com/, 'the refusal names the address that was tried');
  assert.equal(sessionFrom(refused.setCookies), undefined, 'no session is issued');

  nextIdentity = { email: 'owner@gmail.com', email_verified: true };
  const allowed = await signIn();
  assert.ok(sessionFrom(allowed.setCookies), 'the named address still gets in');
  writeFileSync(ALLOWED, '');
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

test('cookie parsing survives the shapes a browser actually sends', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('flag; a=1'), { a: '1' }, 'a valueless cookie is skipped, not fatal');
  assert.deepEqual(parseCookies('a=one%20two'), { a: 'one two' });
});
