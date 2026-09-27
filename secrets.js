// The one server secret, and the keys derived from it.
//
// SESSION_SECRET signs the session cookie (auth.js) and, through a derived key,
// encrypts the Open Library keys users store on their accounts (accounts.js).
// Kept in a module of its own because each of those two imports the other.
import { hkdfSync, randomBytes } from 'node:crypto';

// A secret that survives restarts keeps people signed in across a deploy. One
// generated at boot works just as well for security and signs everybody out
// every time the container restarts, which on a box that restarts nightly is
// indistinguishable from broken — hence the nudge in the startup banner. It
// also makes stored Open Library keys unreadable after a restart, which is
// reported as "not set" rather than as an error.
let bootSecret = null;
export function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  bootSecret ??= randomBytes(32).toString('hex');
  return bootSecret;
}

export function sessionSecretIsEphemeral() {
  return !process.env.SESSION_SECRET;
}

// A separate key per purpose, so that nothing signed for one use can ever be
// mistaken for something encrypted for another.
export function derivedKey(purpose) {
  return Buffer.from(hkdfSync('sha256', secret(), 'home-library', purpose, 32));
}
