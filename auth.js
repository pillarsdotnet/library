// Signing in with Google, and deciding who is let in.
//
// This app held no accounts for its whole life, and the deployments compensated
// for that outside the app: the public VPS binds nginx to the Tailscale address
// rather than 0.0.0.0, precisely because anyone who could reach the port could
// edit the library. Sign-in is what makes that a choice rather than the only
// safe option.
//
// Three rules shape everything below:
//
//   1. Off unless configured. With no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//      there is no identity provider to ask, so the app behaves exactly as it
//      did before — open. Failing closed instead would mean a missing variable
//      silently bricks a home server nobody can log in to fix. The startup log
//      says which mode it is in, every time, so "open" is never a surprise.
//   2. The allowlist is checked on every request, not once at login. Removing
//      an address from the file ends that person's session on their next click;
//      a session that outlived its permission is the thing an allowlist is for.
//   3. Absent or empty means everyone. "Signed in with Google" is itself a
//      meaningful gate — it is the difference between the world and people with
//      an account — so an unwritten file is read as "no further restriction",
//      which is what the file not existing most plainly means.
//
// The OAuth exchange is written out here rather than pulled from a library. It
// is one redirect and one POST, both documented by Google, and a dependency in
// the trust path of the login screen is a dependency worth not having.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Overridable so the tests can point the flow at a stub, the same way
// OPENLIBRARY_BASE does for contributions. Nothing else should set these.
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';

const SESSION_COOKIE = 'hl_session';
const FLOW_COOKIE = 'hl_oauth';
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

// A secret that survives restarts keeps people signed in across a deploy. One
// generated at boot works just as well for security and signs everybody out
// every time the container restarts, which on a box that restarts nightly is
// indistinguishable from broken — hence the nudge in the startup banner.
let bootSecret = null;
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  bootSecret ??= randomBytes(32).toString('hex');
  return bootSecret;
}

export function sessionSecretIsEphemeral() {
  return !process.env.SESSION_SECRET;
}

// ---------------------------------------------------------------------------
// The allowlist file.
// ---------------------------------------------------------------------------

// Beside the database by default, the same as the covers directory — because
// that is the path a deployment already makes persistent. A default under the
// working directory would put the list inside the container image, where an
// edit survives exactly until the next deploy overwrites it.
export function allowlistPath() {
  if (process.env.AUTH_ALLOWED_FILE) return process.env.AUTH_ALLOWED_FILE;
  return join(dirname(process.env.DB_PATH || './data/library.db'), 'allowed-emails.txt');
}

// Re-read only when the file's mtime or size moves. An allowlist is consulted
// on every request (rule 2), and a home server has no business doing a disk
// read per asset when the answer changed last month.
let cached = { key: null, entries: [] };

export function readAllowlist(path = allowlistPath()) {
  let key;
  try {
    const st = statSync(path);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    cached = { key: null, entries: [] };
    return { entries: [], present: false, path };
  }
  if (key !== cached.key) {
    let entries = [];
    try {
      entries = readFileSync(path, 'utf8')
        .split('\n')
        // '#' starts a comment so the file can say why somebody is on it.
        .map((line) => line.replace(/#.*$/, '').trim().toLowerCase())
        .filter(Boolean);
    } catch {
      // Readable a moment ago, unreadable now: treat as empty rather than
      // crash, and let the next request pick up whatever it settles into.
      entries = [];
    }
    cached = { key, entries };
  }
  return { entries: cached.entries, present: true, path };
}

/**
 * Is this address permitted?
 *
 * An absent or empty file permits every signed-in address — see rule 3. Only a
 * file with at least one entry restricts anything.
 */
export function emailAllowed(email, path = allowlistPath()) {
  if (!email) return false;
  const { entries } = readAllowlist(path);
  if (!entries.length) return true;
  return entries.includes(String(email).trim().toLowerCase());
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

export function sessionFor(email) {
  const now = Date.now();
  // `iat` is not read by anything today. It is what an absolute cap on top of
  // the idle window would be written against, so it costs nothing to record.
  return sign({ email: String(email).toLowerCase(), iat: now, exp: now + sessionIdleMs() });
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

/**
 * Mount /auth/login, /auth/callback, /auth/logout and /auth/me on a router.
 *
 * Mounted even when sign-in is switched off, so that /auth/me answers "nobody
 * is signed in and nobody needs to be" rather than 404, which is what lets a
 * client tell the two states apart.
 */
export function mountAuth(router, base = '', doFetch = globalThis.fetch) {
  router.get('/auth/me', (req, res) => {
    if (!authConfigured()) return res.json({ required: false, email: null });
    const session = sessionFromRequest(req);
    const email = session && emailAllowed(session.email) ? session.email : null;
    res.json({ required: true, email });
  });

  router.get('/auth/login', (req, res) => {
    if (!authConfigured()) return res.redirect(safeReturnPath(req.query.to, base));

    // PKCE is not required for a client that holds a secret, but it costs one
    // hash and removes a whole class of "somebody else's code" attack.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');

    res.cookie(FLOW_COOKIE, sign({
      state, verifier, to: safeReturnPath(req.query.to, base), exp: Date.now() + FLOW_TTL_MS,
    }), cookieOptions(req, FLOW_TTL_MS));

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
      // to be signed in as — a shared family machine has several.
      prompt: 'select_account',
    }).toString();
    res.redirect(url.toString());
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

    // Named rather than merely signed in: the refusal says which address was
    // turned away, because the usual cause is signing in with the wrong one of
    // two Google accounts, and "not permitted" alone leaves nothing to act on.
    if (!emailAllowed(claims.email)) {
      return res.status(403).type('text').send(`${claims.email} is not on this library's list.`);
    }

    res.cookie(SESSION_COOKIE, sessionFor(claims.email), cookieOptions(req, sessionIdleMs()));
    res.redirect(safeReturnPath(flow.to, base));
  });

  const signOut = (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect(`${base}/`);
  };
  router.get('/auth/logout', signOut);
  router.post('/auth/logout', signOut);
}

/**
 * The gate. Everything mounted after this needs a signed-in, permitted address.
 *
 * A browser asking for a page is redirected into the flow; anything else gets a
 * 401 carrying the login URL, because a fetch() that follows a redirect to
 * Google ends up parsing Google's HTML as JSON and reporting a nonsense error.
 */
export function requireAuth(base = '') {
  return (req, res, next) => {
    if (!authConfigured()) return next();
    if (req.path.startsWith('/auth/')) return next();

    const session = sessionFromRequest(req);
    if (session && emailAllowed(session.email)) {
      req.user = { email: session.email };
      // Using the library is what keeps you signed in. The expiry is carried in
      // the cookie rather than in any server-side store, so pushing it out means
      // handing back a freshly signed one.
      if (sessionNeedsRefresh(session)) {
        res.cookie(SESSION_COOKIE, sessionFor(session.email), cookieOptions(req, sessionIdleMs()));
      }
      return next();
    }
    // Only a browser *navigating* is sent to Google. `req.accepts` is no use
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
