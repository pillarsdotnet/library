// Signing in with Google, and deciding who is let in, to which library.
//
// This app held no accounts for its whole life, and the deployments compensated
// for that outside the app: the public VPS bound nginx to the Tailscale address
// rather than 0.0.0.0, precisely because anyone who could reach the port could
// edit the library. Sign-in is what makes that a choice rather than the only
// safe option.
//
// Four rules shape everything below:
//
//   1. Off unless configured. With no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//      there is no identity provider to ask, so the app behaves exactly as it
//      did before — open, on its first library. Failing closed instead would
//      mean a missing variable silently bricks a home server nobody can log in
//      to fix. The startup log says which mode it is in, every time.
//   2. Membership is checked on every request, not once at login. Removing a
//      member ends that person's session on their next click; a session that
//      outlived its permission is the thing membership is for.
//   3. Signing in names a library. A name nobody has taken becomes a new
//      library with the person signing in as its only member; a taken name
//      admits its members and nobody else.
//   4. One library at a time. The session carries the library it was opened
//      for; using another means signing in to that one.
//
// The OAuth exchange is written out here rather than pulled from a library. It
// is one redirect and one POST, both documented by Google, and a dependency in
// the trust path of the login screen is a dependency worth not having.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { secret } from './secrets.js';
import {
  normalizeLibraryName, displayName, libraryById, libraryByName, firstLibrary, NAME_MAX,
  findOrCreateUser, userByEmail, isMember, librariesOf, createLibrary,
} from './accounts.js';

export { sessionSecretIsEphemeral } from './secrets.js';

// Overridable so the tests can point the flow at a stub, the same way
// OPENLIBRARY_BASE does for contributions. Nothing else should set these.
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';

const SESSION_COOKIE = 'hl_session';
const FLOW_COOKIE = 'hl_oauth';
// Who signed in last on this browser, and to which library, so the sign-in form
// can offer it again. Outlives the session on purpose: signing out is when it
// is most wanted.
const LAST_COOKIE = 'hl_last';
const LAST_TTL_MS = 365 * 24 * 3600 * 1000;
const FLOW_TTL_MS = 10 * 60 * 1000;          // long enough to type a password

// How long a session survives *without being used*. It is an idle window, not a
// lifetime: every request that arrives inside it pushes the expiry out again
// (see sessionNeedsRefresh), so somebody who opens the library most weeks is
// never asked to sign in again, and somebody who stops using it is signed out
// ten days later.
const DEFAULT_IDLE_DAYS = 10;

// A day count that cannot quietly become "forever". `Number('10d')` is NaN, and
// NaN survives every comparison an expiry check makes — `NaN < Date.now()` is
// false — so a typo in this variable used to mint sessions that never expired,
// silently and in the direction of less security. Anything that is not a finite
// number is the default instead, and the floor is one day.
function idleDays(raw, fallback = DEFAULT_IDLE_DAYS) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? Math.max(n, 1) : fallback;
}

export function sessionIdleDays() {
  return idleDays(process.env.SESSION_IDLE_DAYS);
}

const sessionIdleMs = () => sessionIdleDays() * 24 * 3600 * 1000;

/**
 * Is this session close enough to expiry to be worth re-issuing?
 *
 * Re-issuing on every request would put a Set-Cookie on every stylesheet and
 * every cover image for no gain. Refreshing only once the session is past its
 * half-life costs at most one extra header every five days per browser, and
 * still leaves anyone who visits inside the window permanently signed in.
 */
export function sessionNeedsRefresh(session, now = Date.now(), windowMs = sessionIdleMs()) {
  return !!session && typeof session.exp === 'number' && (session.exp - now) < windowMs / 2;
}

export function authConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// ---------------------------------------------------------------------------
// Signed values. Cookies are the only place this app stores anything a browser
// hands back, so they are signed and their signatures compared in constant time.
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}

function unsign(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  const want = createHmac('sha256', secret()).update(body).digest('base64url');
  // Buffers of different lengths make timingSafeEqual throw rather than return
  // false, and a length mismatch is not a secret worth protecting anyway.
  if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  let value;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.exp !== 'number' || value.exp < Date.now()) return null;
  return value;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// `lib` is the library the session was opened for. A session from before
// libraries has none; the gate settles it (see sessionLibrary).
export function sessionFor(email, libraryId) {
  const now = Date.now();
  // `iat` is not read by anything today. It is what an absolute cap on top of
  // the idle window would be written against, so it costs nothing to record.
  return sign({ email: String(email).toLowerCase(), lib: libraryId, iat: now, exp: now + sessionIdleMs() });
}

export function sessionFromRequest(req) {
  return unsign(parseCookies(req.headers?.cookie)[SESSION_COOKIE]);
}

// ---------------------------------------------------------------------------
// The flow.
// ---------------------------------------------------------------------------

// Where Google is told to send the browser back to. It has to match a URI
// registered on the OAuth client character for character, so an explicit
// setting wins; otherwise it is derived from the request, which is what lets
// one image serve two hostnames without a per-host build.
function redirectUri(req, base) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI;
  const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
  return `${origin}${base}/auth/callback`;
}

// Only ever bounce back to a path on this site. An open redirect here would
// turn the login link into a way to send somebody anywhere with our name on it.
function safeReturnPath(to, base) {
  const fallback = `${base}/`;
  if (typeof to !== 'string' || !to.startsWith('/') || to.startsWith('//')) return fallback;
  return to;
}

function cookieOptions(req, maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',          // the OAuth callback is a top-level GET navigation
    secure: req.secure,       // honours X-Forwarded-Proto when trust proxy is on
    path: '/',
    maxAge: maxAgeMs,
  };
}

// An id_token straight from Google's token endpoint arrives over TLS from a
// host we named, so its signature adds nothing this connection has not already
// established, and verifying it would mean fetching and caching Google's
// rotating JWKS. The claims are still checked: a token for another audience or
// another issuer is not ours to accept, whoever sent it.
function claimsFromIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || typeof claims !== 'object') return null;
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) return null;
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) return null;
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
  // An unverified address is a claim, not an identity: anyone can put somebody
  // else's address on an account they made themselves.
  if (claims.email_verified === false) return null;
  return typeof claims.email === 'string' ? claims : null;
}

// ---------------------------------------------------------------------------
// Pages. Sign-in happens before the app has loaded, so these are plain HTML.
// ---------------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #faf8f5; --fg: #1d1b20; --muted: #6b6570; --accent: #6d4aa8; --line: #d9d3dd; --err: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16131c; --fg: #ece6f0; --muted: #a39cab; --accent: #b39ddb; --line: #3a3342; --err: #f2b8b5; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 16px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { width: 100%; max-width: 380px; }
  h1 { font-size: 1.4rem; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  .hint { color: var(--muted); font-size: 0.9rem; }
  .err { color: var(--err); }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px; border: 1px solid var(--line);
          border-radius: 8px; background: transparent; color: inherit; }
  button, a.btn { display: inline-block; margin-top: 16px; font: inherit; font-weight: 600; padding: 10px 16px; border: 0;
           border-radius: 8px; background: var(--accent); color: var(--bg); cursor: pointer; text-decoration: none; }
  ul { padding-left: 1.2em; }
</style></head>
<body><main>${body}</main></body></html>`;
}

function loginPage({ base, to, library = '', email = '', libraries = [], error = '' }) {
  const mine = libraries.length
    ? `<p class="hint">Your libraries: ${libraries.map((l) => esc(l.name)).join(', ')}</p>` : '';
  return page('Sign in', `
    <h1>📚 Sign in</h1>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="${esc(base)}/auth/login">
      <input type="hidden" name="to" value="${esc(to)}">
      <label for="library">Library</label>
      <input id="library" name="library" required maxlength="${NAME_MAX}" autocomplete="organization"
             value="${esc(library)}" ${library ? '' : 'autofocus'}>
      <p class="hint">The library to open. A name nobody has used yet starts a new library, with you as its only member.</p>
      ${mine}
      ${email ? `<p class="hint">Last signed in here as ${esc(email)}.</p>` : ''}
      <button type="submit" ${library ? 'autofocus' : ''}>Continue with Google</button>
    </form>`);
}

// ---------------------------------------------------------------------------
// Remembering the last sign-in.
// ---------------------------------------------------------------------------

// The remembered sign-in, if this browser has one: { email, library }.
function lastSignIn(req) {
  const v = unsign(parseCookies(req.headers?.cookie)[LAST_COOKIE]);
  return v ? { email: v.email || '', library: v.library || '' } : { email: '', library: '' };
}

/**
 * Mount /auth/login, /auth/callback, /auth/logout and /auth/me on a router.
 *
 * Mounted even when sign-in is switched off, so that /auth/me answers "nobody
 * is signed in and nobody needs to be" rather than 404, which is what lets a
 * client tell the two states apart.
 */
export function mountAuth(router, base = '', doFetch = globalThis.fetch) {
  router.get('/auth/me', (req, res) => {
    if (!authConfigured()) {
      const lib = firstLibrary();
      return res.json({ required: false, email: null, library: { id: lib.id, name: lib.name, display: displayName(lib.name) } });
    }
    const who = signedIn(req);
    if (!who) return res.json({ required: true, email: null, library: null });
    res.json({
      required: true,
      email: who.user.email,
      library: { id: who.library.id, name: who.library.name, display: displayName(who.library.name) },
    });
  });

  // The form. Pre-filled from the last sign-in on this browser, and from
  // ?library= so a link can name one.
  router.get('/auth/login', (req, res) => {
    if (!authConfigured()) return res.redirect(safeReturnPath(req.query.to, base));
    const last = lastSignIn(req);
    const known = last.email ? userByEmail(last.email) : null;
    res.type('html').send(loginPage({
      base,
      to: safeReturnPath(req.query.to, base),
      library: normalizeLibraryName(req.query.library) || last.library,
      email: last.email,
      libraries: known ? librariesOf(known.id) : [],
    }));
  });

  router.post('/auth/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    if (!authConfigured()) return res.redirect(safeReturnPath(req.body?.to, base));
    const to = safeReturnPath(req.body?.to, base);
    const library = normalizeLibraryName(req.body?.library);
    if (!library) {
      return res.status(400).type('html').send(loginPage({
        base, to, library: String(req.body?.library ?? '').slice(0, NAME_MAX), email: lastSignIn(req).email,
        error: `A library name is 1 to ${NAME_MAX} characters.`,
      }));
    }

    // PKCE is not required for a client that holds a secret, but it costs one
    // hash and removes a whole class of "somebody else's code" attack.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');

    // The library rides in the signed flow cookie, not in anything Google sees.
    res.cookie(FLOW_COOKIE, sign({
      state, verifier, to, library, exp: Date.now() + FLOW_TTL_MS,
    }), cookieOptions(req, FLOW_TTL_MS));

    const last = lastSignIn(req);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(req, base),
      response_type: 'code',
      scope: 'openid email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Ask for an account rather than silently reusing the one Google happens
      // to be signed in as — a shared family machine has several. The last
      // address used here is offered first.
      prompt: 'select_account',
      ...(last.email ? { login_hint: last.email } : {}),
    }).toString();
    res.redirect(303, url.toString());
  });

  router.get('/auth/callback', async (req, res) => {
    if (!authConfigured()) return res.redirect(base || '/');

    const flow = unsign(parseCookies(req.headers.cookie)[FLOW_COOKIE]);
    res.clearCookie(FLOW_COOKIE, { path: '/' });
    if (!flow) return res.status(400).type('text').send('Sign-in took too long — try again.');
    // The state in the URL must match the one in the cookie we set. Mismatched,
    // this is somebody else's login being finished in your browser.
    if (!req.query.state || req.query.state !== flow.state) {
      return res.status(400).type('text').send('Sign-in could not be verified — try again.');
    }
    if (req.query.error) return res.status(400).type('text').send('Google declined the sign-in.');
    if (!req.query.code) return res.status(400).type('text').send('Google sent no authorization code.');
    const name = normalizeLibraryName(flow.library);
    if (!name) return res.status(400).type('text').send('Sign-in did not say which library — try again.');

    let claims = null;
    try {
      const r = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri(req, base),
          grant_type: 'authorization_code',
          code_verifier: flow.verifier,
        }).toString(),
      });
      if (r.ok) claims = claimsFromIdToken((await r.json()).id_token);
    } catch {
      claims = null;   // network, DNS, TLS: all the same answer to the visitor
    }
    if (!claims) return res.status(502).type('text').send('Could not complete sign-in with Google.');

    const user = findOrCreateUser(claims.email);
    let library = libraryByName(name);
    if (!library) {
      // Nobody has this name: it is a new library, and this person founds it.
      // Two people racing for one new name both reach here; the unique index
      // lets one create it, and the other is then an ordinary non-member.
      try {
        library = createLibrary(name, user.id);
      } catch (e) {
        if (!/UNIQUE/i.test(e.message)) throw e;
        library = libraryByName(name);
      }
    }
    // Named rather than merely refused: the usual cause is signing in with the
    // wrong one of two Google accounts, or mistyping the library, and "not
    // permitted" alone leaves nothing to act on.
    if (!isMember(library.id, user.id)) {
      return res.status(403).type('html').send(page('Not a member', `
        <h1>Not a member</h1>
        <p>${esc(claims.email)} is not a member of ${esc(displayName(library.name))}.</p>
        <p class="hint">A member of that library can add you from its Members screen. Or sign in with another
          account, or to another library.</p>
        <a class="btn" href="${esc(base)}/auth/login">Back to sign in</a>`));
    }

    res.cookie(SESSION_COOKIE, sessionFor(user.email, library.id), cookieOptions(req, sessionIdleMs()));
    res.cookie(LAST_COOKIE, sign({ email: user.email, library: library.name, exp: Date.now() + LAST_TTL_MS }),
      cookieOptions(req, LAST_TTL_MS));
    res.redirect(safeReturnPath(flow.to, base));
  });

  // Signing out ends the session and keeps the remembered sign-in, so the form
  // is ready for the next one.
  const signOut = (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect(`${base}/auth/login`);
  };
  router.get('/auth/logout', signOut);
  router.post('/auth/logout', signOut);
}

// The user and library a request's session stands for, or null when it stands
// for nothing a member may use: no session, an expired one, an address that is
// not a user, or a library the user is no longer a member of.
//
// A session from before libraries names no library. It stood for the only one
// there was, so it is honoured for a user who belongs to exactly one library,
// which carries the people signed in at the upgrade across it.
function signedIn(req) {
  const session = sessionFromRequest(req);
  if (!session) return null;
  const user = userByEmail(session.email);
  if (!user) return null;
  let libraryId = session.lib;
  if (libraryId == null) {
    const mine = librariesOf(user.id);
    if (mine.length !== 1) return null;
    libraryId = mine[0].id;
  }
  const library = libraryById(libraryId);
  if (!library || !isMember(library.id, user.id)) return null;
  return { session, user, library };
}

/**
 * The gate. Everything mounted after this needs a member of the session's
 * library, and gets req.user and req.library.
 *
 * With sign-in off there is no user, and the library is the first one.
 *
 * A browser asking for a page is sent to the sign-in form; anything else gets a
 * 401 carrying the login URL, because a fetch() that follows a redirect to
 * Google ends up parsing Google's HTML as JSON and reporting a nonsense error.
 */
export function requireAuth(base = '') {
  return (req, res, next) => {
    if (!authConfigured()) {
      req.user = null;
      req.library = firstLibrary();
      return next();
    }
    if (req.path.startsWith('/auth/')) return next();

    const who = signedIn(req);
    if (who) {
      req.user = who.user;
      req.library = who.library;
      // Using the library is what keeps you signed in. The expiry is carried in
      // the cookie rather than in any server-side store, so pushing it out means
      // handing back a freshly signed one — naming the library, which also
      // upgrades a session from before libraries.
      if (sessionNeedsRefresh(who.session) || who.session.lib == null) {
        res.cookie(SESSION_COOKIE, sessionFor(who.user.email, who.library.id), cookieOptions(req, sessionIdleMs()));
      }
      return next();
    }
    // Only a browser *navigating* is sent to sign in. `req.accepts` is no use
    // here: a fetch() with the default `Accept: */*` matches text/html as
    // happily as a page load does, and an API call that follows a redirect to
    // Google ends up parsing a sign-in page as JSON and reporting nonsense.
    // Asking for text/html by name is the thing only a navigation does — and
    // /api is never a navigation whatever it claims to accept.
    const navigating = req.method === 'GET'
      && !req.path.startsWith('/api/')
      && String(req.headers.accept || '').includes('text/html');
    if (navigating) {
      return res.redirect(`${base}/auth/login?to=${encodeURIComponent(req.originalUrl)}`);
    }
    res.status(401).json({ error: 'Sign in required', login: `${base}/auth/login` });
  };
}
