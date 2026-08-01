// Cover images on disk.
//
// They used to live in the database as base64 data-URLs, which made them roughly
// half of its bytes: every backup, every failover handoff and every hourly sync
// carried ~7 MB of image data that SQLite is not the right place for. They are
// files now, beside the database, and the database holds only a filename and a
// token.
//
// WHAT THE TOKEN IS FOR
// The URL a client is given must change when the image changes, or a browser
// holding a cached copy goes on showing the old photo after a new one is saved —
// which looks exactly like the save having failed. The token is a hash of the
// image bytes, so it changes exactly when the image does, and a URL carrying one
// can be cached hard because it names one particular image forever.
//
// The files live beside the database ON PURPOSE: the failover handoff, the hourly
// sync and any backup all have to move both, and a covers directory somewhere
// else is one that eventually gets left behind. See db-sync.sh and the
// covers-send/covers-recv verbs in failover-peer.sh.
import { mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, basename } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/library.db';
export const COVERS_DIR = process.env.COVERS_DIR || join(dirname(DB_PATH), 'covers');

// Only formats a browser will render, and each maps to exactly one extension so
// the file's name states its type and the serving path needs no lookup table of
// its own. Anything else is refused rather than stored under a guessed name.
const EXT_FOR_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif',
};
const MIME_FOR_EXT = Object.fromEntries(Object.entries(EXT_FOR_MIME).map(([m, e]) => [e, m]));

export const mimeForFile = (file) => MIME_FOR_EXT[String(file).split('.').pop()] || 'application/octet-stream';

// Short, URL-safe, and derived from the bytes. Truncated because this is a cache
// key, not a security claim: it only has to change when the image does.
export const coverToken = (buf) => createHash('sha256').update(buf).digest('base64url').slice(0, 12);

/** Split a data: URL into its type and bytes. Returns null for anything else. */
export function parseDataUrl(s) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return null;
  return { mime: m[1].toLowerCase(), buf };
}

/**
 * Write an image and return { file, token }, or null if the type is not one we
 * serve. `stem` names the copy it belongs to ("125", "125-source").
 *
 * Written to a temporary name and renamed into place, so a reader can never see
 * a half-written image: rename within a directory is atomic, a partial write is
 * not. The previous file for this stem is removed only after the new one lands,
 * and only if the extension changed — otherwise the rename has already replaced it.
 */
export function writeCover(stem, buf, mime, previousFile = null) {
  const ext = EXT_FOR_MIME[String(mime).toLowerCase()];
  if (!ext) return null;
  mkdirSync(COVERS_DIR, { recursive: true });
  const file = `${stem}.${ext}`;
  const tmp = join(COVERS_DIR, `.${file}.tmp`);
  writeFileSync(tmp, buf);
  renameSync(tmp, join(COVERS_DIR, file));
  if (previousFile && previousFile !== file) removeCover(previousFile);
  return { file, token: coverToken(buf) };
}

/** Absolute path of a stored cover, or null if the name is not one of ours. */
export function coverPath(file) {
  // The name comes from our own database, but it reaches this function on its way
  // to the filesystem, so it is treated as untrusted anyway: only a bare filename
  // is ever resolved, which leaves no way to address anything outside the directory.
  if (!file || basename(file) !== file) return null;
  const p = join(COVERS_DIR, file);
  return existsSync(p) ? p : null;
}

export function removeCover(file) {
  if (!file || basename(file) !== file) return;
  rmSync(join(COVERS_DIR, file), { force: true });
}
