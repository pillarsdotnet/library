// Wishlists: the one page of this app that strangers may see.
//
// A book whose status is 'wishlist' sits on one USER's wishlist — whoever set
// the status — not the library's. Each user has one shareable address for
// theirs, /wishlist/<token>, mounted in front of the sign-in gate:
//
//   - Anyone holding the URL may look at the books. Holding it IS the
//     permission: the token is long and random, and the page offers no way to
//     edit anything.
//   - A signed-in visitor who is not the wishlist's owner may record buying a
//     book: the date they choose, and their own address. A book bought once
//     shows its purchase instead of the button, which is what stops a second
//     copy being bought in good faith.
//   - The owner is shown no purchase until its date has passed. A gift is a
//     surprise; the same rule is applied to the owner's own API in server.js
//     (hidePurchase), so the secret never even reaches their browser.
//
// The page is rendered here, plain HTML with no script: the purchase date is
// asked for by a <details> fold, and the purchase itself is an ordinary form
// POST. Nothing on it needs the app's bundle, and a visitor gets no cookie.
import { randomBytes } from 'node:crypto';
import express from 'express';
import db from './db.js';
import { coverPath, mimeForFile } from './covers.js';
import { authConfigured, sessionFromRequest } from './auth.js';
import { userByEmail, firstLibrary, displayName } from './accounts.js';

// The calendar date here, not UTC — the same reasoning as the overdue filter:
// whether a purchase may be shown is a question about the calendar on the
// wall, and SQLite's localtime reads the process timezone the server logs.
export const todayLocalIso = () => db.prepare("SELECT date('now', 'localtime') AS d").get().d;

// ─── tokens ──────────────────────────────────────────────────────────────────

// The user's share token, minted on first use and stable after that: the URL
// gets written into messages and bookmarks, so it must not churn.
export function wishlistToken(userId) {
  const uid = userId ?? 0;
  const row = db.prepare('SELECT token FROM wishlist_tokens WHERE user_id = ?').get(uid);
  if (row) return row.token;
  const token = randomBytes(16).toString('base64url');
  db.prepare('INSERT INTO wishlist_tokens (user_id, token) VALUES (?, ?)').run(uid, token);
  return token;
}

// The wishlist a token names, or null. No timing-safe comparison needed: the
// lookup is by unique index, and guessing 128 random bits is not a plan.
function userIdForToken(token) {
  const row = db.prepare('SELECT user_id FROM wishlist_tokens WHERE token = ?').get(String(token ?? ''));
  return row ? row.user_id : null;
}

// ─── the wishlist itself ─────────────────────────────────────────────────────

// Per user across every library — a wishlist is personal, so the books follow
// the person, not the tenancy.
const wishlistBooks = (uid) => db.prepare(`
  SELECT c.id, c.purchased_by, c.purchase_date, c.cover_file, c.cover_token,
         e.title, e.authors, e.publisher, e.published_date, e.page_count, e.format,
         COALESCE(e.isbn13, e.isbn_text) AS isbn, e.cover_url AS edition_cover_url
  FROM copies c JOIN editions e ON e.id = c.edition_id
  WHERE c.status = 'wishlist' AND COALESCE(c.wishlist_user_id, 0) = ?
  ORDER BY sort_title(e.title)`).all(uid);

// Whose wishlist to call it. User 0 has no address, so the library speaks for them.
function ownerName(uid) {
  if (uid === 0) return displayName(firstLibrary().name);
  return db.prepare('SELECT email FROM users WHERE id = ?').get(uid)?.email ?? 'Somebody';
}

// The signed-in visitor, if any. Identity is all that matters here — which
// library their session was opened for is irrelevant to somebody else's
// wishlist — so this checks the session, not any membership.
function viewerOf(req) {
  if (!authConfigured()) return null;
  const session = sessionFromRequest(req);
  return session ? (userByEmail(session.email) ?? null) : null;
}

// ─── the page ────────────────────────────────────────────────────────────────

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const FORMAT_LABELS = {
  paperback: 'Paperback', hardback: 'Hardback', ebook: 'E-book', audiobook: 'Audiobook', other: '',
};

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #faf8f5; --fg: #1d1b20; --muted: #6b6570; --accent: #6d4aa8; --line: #d9d3dd; --card: #ffffff; --ok: #2e7d4f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16131c; --fg: #ece6f0; --muted: #a39cab; --accent: #b39ddb; --line: #3a3342; --card: #201c28; --ok: #86d3a2; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; padding: 24px 16px 48px; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .hint { color: var(--muted); font-size: 0.9rem; margin: 0 0 20px; }
  ul.books { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  li.book { display: flex; gap: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  .cover { width: 56px; height: 84px; object-fit: cover; border-radius: 4px; flex: none; background: var(--bg); }
  .cover.placeholder { display: grid; place-items: center; font-size: 1.6rem; }
  .book h2 { font-size: 1.05rem; margin: 0; }
  .book .authors { margin: 0 0 4px; color: var(--muted); }
  .book .facts { margin: 0; font-size: 0.85rem; color: var(--muted); }
  .bought { margin: 8px 0 0; font-size: 0.9rem; color: var(--ok); font-weight: 600; }
  details.buy { margin-top: 8px; }
  details.buy summary { display: inline-block; cursor: pointer; font-weight: 600; padding: 7px 14px; border-radius: 8px; background: var(--accent); color: var(--bg); }
  details.buy summary::-webkit-details-marker { display: none; }
  details.buy form { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  details.buy label { display: block; font-size: 0.85rem; color: var(--muted); }
  details.buy input { display: block; font: inherit; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  details.buy button { font: inherit; font-weight: 600; padding: 8px 14px; border: 0; border-radius: 8px; background: var(--accent); color: var(--bg); cursor: pointer; }
  .empty { color: var(--muted); padding: 32px 0; text-align: center; }
  a { color: var(--accent); }
  .err { color: #b3261e; }
</style></head>
<body><main>${body}</main></body></html>`;
}

const notFound = (res) => res.status(404).type('html')
  .send(page('Not found', '<h1>Not found</h1><p class="hint">This wishlist address is not one we know.</p>'));

// What one book shows about its purchase, which depends entirely on who is
// looking. The owner: nothing until the date has passed, then the full record.
// A signed-in visitor: the record, or the button that makes one. A stranger:
// "spoken for" without the buyer's address — the URL travels further than the
// owner can see, and an email address is not for everyone who holds it.
function purchaseBlock(b, { isOwner, signedIn, base, token, today }) {
  if (b.purchased_by) {
    const record = `<p class="bought">🎁 Purchased by ${esc(b.purchased_by)} on ${esc(b.purchase_date)}</p>`;
    if (isOwner) return b.purchase_date < today ? record : '';
    return signedIn ? record : '<p class="bought">🎁 Spoken for</p>';
  }
  if (!signedIn || isOwner) return '';
  return `<details class="buy"><summary>🎁 Purchase</summary>
    <form method="post" action="${esc(base)}/wishlist/${esc(token)}/purchase">
      <input type="hidden" name="book_id" value="${b.id}">
      <label>Purchase date
        <input type="date" name="purchase_date" value="${esc(today)}" required></label>
      <button type="submit">Mark as purchased</button>
    </form></details>`;
}

function bookRow(b, base, token, who) {
  const cover = b.cover_file
    ? `<img class="cover" src="${esc(base)}/wishlist/${esc(token)}/cover/${b.id}?v=${esc(b.cover_token)}" alt="" loading="lazy">`
    : b.edition_cover_url
      ? `<img class="cover" src="${esc(b.edition_cover_url)}" alt="" loading="lazy">`
      : '<div class="cover placeholder">📖</div>';
  const facts = [
    FORMAT_LABELS[b.format] ?? b.format,
    b.publisher,
    b.published_date,
    b.page_count ? `${b.page_count} pages` : '',
    b.isbn ? `ISBN ${b.isbn}` : '',
  ].filter(Boolean).join(' · ');
  return `<li class="book">${cover}
    <div>
      <h2>${esc(b.title)}</h2>
      <p class="authors">${esc(b.authors || 'Unknown author')}</p>
      ${facts ? `<p class="facts">${esc(facts)}</p>` : ''}
      ${purchaseBlock(b, who)}
    </div></li>`;
}

/**
 * Mount the public wishlist routes. Called BEFORE requireAuth, deliberately:
 * the whole point of the URL is that it works for somebody with no account
 * here. Each route re-derives everything from the token, so nothing gated
 * leaks: a book is only ever shown or sold through the wishlist it is on.
 */
export function mountWishlist(router, base = '') {
  router.get('/wishlist/:token', (req, res) => {
    const uid = userIdForToken(req.params.token);
    if (uid == null) return notFound(res);

    const viewer = viewerOf(req);
    const who = {
      isOwner: !!viewer && viewer.id === uid,
      signedIn: !!viewer,
      base,
      token: req.params.token,
      today: todayLocalIso(),
    };
    const books = wishlistBooks(uid);
    const name = ownerName(uid);
    // A stranger can sign in to earn the Purchase button — their own library
    // is fine, any signed-in identity counts — so say so instead of leaving
    // the page silently read-only.
    const hint = who.isOwner
      ? 'Your wishlist, as visitors see it. A purchase stays hidden from you until its date has passed.'
      : who.signedIn || !authConfigured()
        ? 'Mark a book as purchased so nobody buys it twice.'
        : `Looking is open to all. <a href="${esc(base)}/auth/login?to=${encodeURIComponent(`${base}/wishlist/${req.params.token}`)}">Sign in</a> to mark a book as purchased.`;
    res.type('html').send(page(`${name} — wishlist`, `
      <h1>🎁 ${esc(name)}’s wishlist</h1>
      <p class="hint">${hint}</p>
      ${books.length
        ? `<ul class="books">${books.map((b) => bookRow(b, base, req.params.token, who)).join('')}</ul>`
        : '<p class="empty">Nothing on this wishlist right now.</p>'}`));
  });

  // A wishlist book's own photograph. The edition's stock artwork is a plain
  // URL and goes straight into the page; only the file needs serving.
  router.get('/wishlist/:token/cover/:id', (req, res) => {
    const uid = userIdForToken(req.params.token);
    if (uid == null) return res.status(404).json({ error: 'Not found' });
    const row = db.prepare(`SELECT cover_file FROM copies
      WHERE id = ? AND status = 'wishlist' AND COALESCE(wishlist_user_id, 0) = ?`).get(req.params.id, uid);
    const path = row?.cover_file ? coverPath(row.cover_file) : null;
    if (!path) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Type', mimeForFile(row.cover_file));
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    return res.sendFile(path);
  });

  // Recording a purchase. Refused without a signed-in identity (the address is
  // the record), for the wishlist's own owner, and for a book already bought —
  // buying it twice is the thing this exists to prevent.
  router.post('/wishlist/:token/purchase', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const uid = userIdForToken(req.params.token);
    if (uid == null) return notFound(res);
    const back = `${base}/wishlist/${req.params.token}`;
    const refuse = (status, msg) => res.status(status).type('html').send(page('Wishlist', `
      <h1>🎁 Wishlist</h1><p class="err">${esc(msg)}</p>
      <p><a href="${esc(back)}">Back to the wishlist</a></p>`));

    const viewer = viewerOf(req);
    if (!viewer) return refuse(401, 'Sign in to mark a purchase.');
    if (viewer.id === uid) return refuse(403, 'Your own wishlist is for other people to buy from.');
    const date = String(req.body?.purchase_date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse(400, 'The purchase date must be a date.');
    const book = db.prepare(`SELECT id, purchased_by FROM copies
      WHERE id = ? AND status = 'wishlist' AND COALESCE(wishlist_user_id, 0) = ?`)
      .get(Number(req.body?.book_id), uid);
    if (!book) return refuse(404, 'That book is not on this wishlist.');
    if (book.purchased_by) return refuse(409, 'Somebody already purchased that one.');
    db.prepare("UPDATE copies SET purchased_by = ?, purchase_date = ?, updated_at = datetime('now') WHERE id = ?")
      .run(viewer.email, date, book.id);
    res.redirect(303, back);
  });
}
