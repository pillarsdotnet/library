// Libraries, the people who may use them, and those people's Open Library keys.
//
// Authorization is rows, not a file: a user may use a library exactly when
// library_users links the two. Signing in names a library; naming one nobody
// has taken yet creates it, with the person signing in as its founding member.
// The server's owner (OWNER_ID) is a member of every library besides, which
// the database sees to (see db.js).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import db, { seedGenres, OWNER_ID } from './db.js';
import { derivedKey } from './secrets.js';

// ─── library names ──────────────────────────────────────────────────────────────

export const NAME_MAX = 60;

// What was typed, tidied, or null when it cannot be a name. Whitespace is
// collapsed so "Bobbalisa " and "Bobbalisa" are one library; case is kept for
// display and ignored for matching (the unique index is COLLATE NOCASE).
export function normalizeLibraryName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > NAME_MAX) return null;
  // Control characters have no place in a name shown in a header.
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  return name;
}

// "Bobbalisa" reads as "Bobbalisa Library"; a name that already says Library
// is not made to say it twice.
export function displayName(name) {
  return /\blibrary$/i.test(name) ? name : `${name} Library`;
}

export const libraryById = (id) => db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
export const libraryByName = (name) => db.prepare('SELECT * FROM libraries WHERE name = ? COLLATE NOCASE').get(name);
// With sign-in off there is nobody to choose, so the first library is the one.
export const firstLibrary = () => db.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get();

// ─── users and membership ───────────────────────────────────────────────────────

export { OWNER_ID };
export const owner = () => db.prepare('SELECT * FROM users WHERE id = ?').get(OWNER_ID);
export const userByEmail = (email) => db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email));

export function findOrCreateUser(email) {
  const address = String(email).trim().toLowerCase();
  db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)').run(address);
  return userByEmail(address);
}

export function isMember(libraryId, userId) {
  return !!db.prepare('SELECT 1 FROM library_users WHERE library_id = ? AND user_id = ?').get(libraryId, userId);
}

export function librariesOf(userId) {
  return db.prepare(`SELECT l.* FROM libraries l JOIN library_users lu ON lu.library_id = l.id
                     WHERE lu.user_id = ? ORDER BY l.name COLLATE NOCASE`).all(userId);
}

// A new library, its founding member and its starter genres, all or nothing.
// A library that exists without a member is one nobody can ever sign in to.
// OR IGNORE because the owner founding one is already in it, by trigger.
export function createLibrary(name, userId) {
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO libraries (name) VALUES (?)').run(name).lastInsertRowid;
    db.prepare('INSERT OR IGNORE INTO library_users (library_id, user_id) VALUES (?, ?)').run(id, userId);
    seedGenres(id);
    return libraryById(id);
  })();
}

export function members(libraryId) {
  return db.prepare(`SELECT u.id, u.email, u.id = ${OWNER_ID} AS owner, lu.created_at AS added_at, a.email AS added_by
                     FROM library_users lu JOIN users u ON u.id = lu.user_id
                     LEFT JOIN users a ON a.id = lu.added_by
                     WHERE lu.library_id = ? ORDER BY u.email`).all(libraryId)
    .map((m) => ({ ...m, owner: !!m.owner }));
}

export function addMember(libraryId, email, addedBy) {
  const user = findOrCreateUser(email);
  db.prepare('INSERT OR IGNORE INTO library_users (library_id, user_id, added_by) VALUES (?, ?, ?)')
    .run(libraryId, user.id, addedBy ?? null);
  return user;
}

// Refused for yourself — a slip of the finger would lock you out with nobody
// signed in to let you back — for the owner, who belongs to every library,
// and for the last member, which would leave a library nobody can reach.
// Returns an error message, or null when done.
export function removeMember(libraryId, userId, actingUserId) {
  if (userId === actingUserId) return 'You cannot remove yourself.';
  if (userId === OWNER_ID) return 'The server\'s owner is a member of every library.';
  if (!isMember(libraryId, userId)) return 'Not a member of this library.';
  const n = db.prepare('SELECT COUNT(*) AS n FROM library_users WHERE library_id = ?').get(libraryId).n;
  if (n <= 1) return 'A library must keep at least one member.';
  db.prepare('DELETE FROM library_users WHERE library_id = ? AND user_id = ?').run(libraryId, userId);
  return null;
}

// ─── a user's Open Library keys ────────────────────────────────────────────────
// Encrypted at rest because the database travels: every handoff, hourly sync
// and backup carries a copy. AES-256-GCM under a key derived from
// SESSION_SECRET; without that secret a copy of the database holds nothing
// usable. Stored as "v1.<iv>.<tag>.<ciphertext>", base64url.

const KEY_PURPOSE = 'openlibrary-credentials';

function seal(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', derivedKey(KEY_PURPOSE), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

function open(sealed) {
  const [v, iv, tag, body] = String(sealed ?? '').split('.');
  if (v !== 'v1' || !iv || !tag || !body) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', derivedKey(KEY_PURPOSE), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    // Sealed under another SESSION_SECRET. The keys are unrecoverable, which is
    // the same as not having any: the user enters them again.
    return null;
  }
}

export function setOlCredentials(userId, { access, secret }) {
  db.prepare(`UPDATE users SET ol_access_key = ?, ol_secret_key = ?, ol_verified_at = datetime('now')
              WHERE id = ?`).run(seal(access), seal(secret), userId);
}

export function clearOlCredentials(userId) {
  db.prepare('UPDATE users SET ol_access_key = NULL, ol_secret_key = NULL, ol_verified_at = NULL WHERE id = ?').run(userId);
}

// { access, secret } or null. Only keys that were verified when saved count.
export function olCredentials(userId) {
  const u = db.prepare('SELECT ol_access_key, ol_secret_key, ol_verified_at FROM users WHERE id = ?').get(userId);
  if (!u?.ol_verified_at) return null;
  const access = open(u.ol_access_key);
  const secret = open(u.ol_secret_key);
  return access && secret ? { access, secret } : null;
}

// What the account screen may show: never the secret, and only enough of the
// access key to tell two sets apart.
export function olStatus(userId) {
  const creds = olCredentials(userId);
  if (!creds) return { active: false };
  const u = db.prepare('SELECT ol_verified_at FROM users WHERE id = ?').get(userId);
  return { active: true, verified_at: u.ol_verified_at, access_hint: `…${creds.access.slice(-4)}` };
}
