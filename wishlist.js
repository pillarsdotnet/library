// Wishlists: the one page of this app that strangers may see.
//
// A user's wishlist is the books whose status is 'wishlist' in THEIR OWN
// user_statuses rows (statuses are per user — see db.js), so it is personal by
// construction, never the library's. Each one has a readable address naming
// the library and the person, /wishlist/<library>/<email> — or /wishlist/
// <library> alone on a server running without sign-in, where the wishlist is
// the anonymous user's (user 0). Both parts match case-insensitively, like the
// names themselves do everywhere else, and the address the app offers for
// sharing is the lower-case spelling. Mounted in front of the sign-in gate:
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
import express from 'express';
import db from './db.js';
import { coverPath, mimeForFile } from './covers.js';
import { authConfigured, sessionFromRequest } from './auth.js';
import { userByEmail, libraryByName, isMember, displayName } from './accounts.js';

// The calendar date here, not UTC — the same reasoning as the overdue filter:
// whether a purchase may be shown is a question about the calendar on the
// wall, and SQLite's localtime reads the process timezone the server logs.
export const todayLocalIso = () => db.prepare("SELECT date('now', 'localtime') AS d").get().d;

// ─── the address ─────────────────────────────────────────────────────────────

// The canonical, shareable spelling of a wishlist's path: the library and the
// person, both lower-cased — names and addresses are case-preserving but
// match case-insensitively, so every casing is the same page, and the one the
// app hands out is the one that reads calmest in a message. No email names
// the anonymous user of a server running without sign-in, whose wishlist is
// the library's path alone.
export function wishlistPath(libraryName, email) {
  const seg = (s) => encodeURIComponent(String(s).toLowerCase());
  return email ? `wishlist/${seg(libraryName)}/${seg(email)}` : `wishlist/${seg(libraryName)}`;
}

// The wishlist an address names — { library, uid } — or null. The library and
// the member must both exist, and the email must name a member of THAT
// library: the address says where the wish was made, not just whose it is.
// Without an email the address is the anonymous user's, which only a server
// running without sign-in has.
function wishlistOf(params) {
  const library = libraryByName(params.library);
  if (!library) return null;
  if (params.email === undefined) {
    return authConfigured() ? null : { library, uid: 0 };
  }
  const user = userByEmail(params.email);
  if (!user || !isMember(library.id, user.id)) return null;
  return { library, uid: user.id };
}

// ─── the wishlist itself ─────────────────────────────────────────────────────

// One person's wishes in one library — the library the address names, since
// the address now says where as well as whose.
const wishlistBooks = (uid, libraryId) => db.prepare(`
  SELECT c.id, us.purchased_by, us.purchase_date, c.cover_file, c.cover_token,
         e.title, e.authors, e.publisher, e.published_date, e.page_count, e.format,
         COALESCE(e.isbn13, e.isbn_text) AS isbn, e.cover_url AS edition_cover_url
  FROM user_statuses us
  JOIN copies c ON c.id = us.copy_id
  JOIN editions e ON e.id = c.edition_id
  WHERE us.user_id = ? AND us.status = 'wishlist' AND c.library_id = ?
  ORDER BY sort_title(e.title)`).all(uid, libraryId);

// Whose wishlist to call it, as the name was stored — displayed case-preserved
// even though the URL was lower-cased. User 0 is the anonymous user of a
// server running without sign-in: nobody has an account there, so there is no
// email to name the page with, and the library speaks for them instead.
function ownerName(uid, library) {
  if (uid === 0) return displayName(library.name);
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
  p.buy { margin: 8px 0 0; }
  a.buy-link { display: inline-block; font-weight: 600; padding: 7px 14px; border-radius: 8px; background: var(--accent); color: var(--bg); text-decoration: none; }
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
// owner can see, and an email address is not for everyone who holds it — or
// the same Purchase button, which for them leads through sign-in (library and
// account) and back here with the date form open (?buy=<id>), so the purchase
// completes only once they are somebody. Refusing to sign in just comes back
// to the list, nothing done.
function purchaseBlock(b, { isOwner, signedIn, base, path, today, buyId }) {
  if (b.purchased_by) {
    const record = `<p class="bought">🎁 Purchased by ${esc(b.purchased_by)} on ${esc(b.purchase_date)}</p>`;
    if (isOwner) return b.purchase_date < today ? record : '';
    return signedIn ? record : '<p class="bought">🎁 Spoken for</p>';
  }
  if (isOwner) return '';
  if (!signedIn) {
    const back = `${base}/${path}?buy=${b.id}`;
    return `<p class="buy"><a class="buy-link" href="${esc(base)}/auth/login?to=${encodeURIComponent(back)}">🎁 Purchase</a></p>`;
  }
  return `<details class="buy"${buyId === b.id ? ' open' : ''}><summary>🎁 Purchase</summary>
    <form method="post" action="${esc(base)}/${esc(path)}/purchase">
      <input type="hidden" name="book_id" value="${b.id}">
      <label>Purchase date
        <input type="date" name="purchase_date" value="${esc(today)}" required></label>
      <button type="submit">Mark as purchased</button>
    </form></details>`;
}

function bookRow(b, base, who) {
  const cover = b.cover_file
    ? `<img class="cover" src="${esc(base)}/${esc(who.path)}/cover/${b.id}?v=${esc(b.cover_token)}" alt="" loading="lazy">`
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
      ${purchaseBlock(b, { ...who, base })}
    </div></li>`;
}

/**
 * Mount the public wishlist routes. Called BEFORE requireAuth, deliberately:
 * the whole point of the URL is that it works for somebody with no account
 * here. Each route re-derives everything from the token, so nothing gated
 * leaks: a book is only ever shown or sold through the wishlist it is on.
 */
export function mountWishlist(router, base = '') {
  // The second pattern of each pair is the anonymous user's, library alone —
  // only a server running without sign-in has one (see wishlistOf).
  router.get(['/wishlist/:library/:email/cover/:id', '/wishlist/:library/cover/:id'],
    (req, res) => {
      // A wishlist book's own photograph. The edition's stock artwork is a
      // plain URL and goes straight into the page; only the file needs serving.
      const wl = wishlistOf(req.params);
      if (!wl) return res.status(404).json({ error: 'Not found' });
      const row = db.prepare(`SELECT c.cover_file FROM copies c
        JOIN user_statuses us ON us.copy_id = c.id
        WHERE c.id = ? AND c.library_id = ? AND us.user_id = ? AND us.status = 'wishlist'`)
        .get(req.params.id, wl.library.id, wl.uid);
      const path = row?.cover_file ? coverPath(row.cover_file) : null;
      if (!path) return res.status(404).json({ error: 'Not found' });
      res.set('Content-Type', mimeForFile(row.cover_file));
      res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
      return res.sendFile(path);
    });

  router.get(['/wishlist/:library/:email', '/wishlist/:library'], (req, res) => {
    const wl = wishlistOf(req.params);
    if (!wl) return notFound(res);

    const name = ownerName(wl.uid, wl.library);
    // Links on the page use the canonical lower-case spelling, whatever casing
    // got the visitor here.
    const path = wishlistPath(wl.library.name, wl.uid === 0 ? null : name);
    const viewer = viewerOf(req);
    const who = {
      isOwner: !!viewer && viewer.id === wl.uid,
      signedIn: !!viewer,
      base,
      path,
      today: todayLocalIso(),
      // Arriving back from the sign-in that a Purchase click started: open
      // that book's date form, so the purchase carries on where it left off.
      buyId: Number(req.query.buy) || 0,
    };
    const books = wishlistBooks(wl.uid, wl.library.id);
    const hint = who.isOwner
      ? 'Your wishlist, as visitors see it. A purchase stays hidden from you until its date has passed.'
      : who.signedIn || !authConfigured()
        ? 'Mark a book as purchased so nobody buys it twice.'
        : 'Looking is open to all. Marking a purchase asks you to sign in first — any library, your own included.';
    res.type('html').send(page(`${name} — wishlist`, `
      <h1>🎁 ${esc(name)}’s wishlist</h1>
      <p class="hint">${hint}</p>
      ${books.length
        ? `<ul class="books">${books.map((b) => bookRow(b, base, who)).join('')}</ul>`
        : '<p class="empty">Nothing on this wishlist right now.</p>'}`));
  });

  // Recording a purchase. Refused without a signed-in identity (the address is
  // the record), for the wishlist's own owner, and for a book already bought —
  // buying it twice is the thing this exists to prevent.
  router.post(['/wishlist/:library/:email/purchase', '/wishlist/:library/purchase'],
    express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      const wl = wishlistOf(req.params);
      if (!wl) return notFound(res);
      const name = ownerName(wl.uid, wl.library);
      const back = `${base}/${wishlistPath(wl.library.name, wl.uid === 0 ? null : name)}`;
      const refuse = (status, msg) => res.status(status).type('html').send(page('Wishlist', `
      <h1>🎁 Wishlist</h1><p class="err">${esc(msg)}</p>
      <p><a href="${esc(back)}">Back to the wishlist</a></p>`));

      const viewer = viewerOf(req);
      if (!viewer) return refuse(401, 'Sign in to mark a purchase.');
      if (viewer.id === wl.uid) return refuse(403, 'Your own wishlist is for other people to buy from.');
      const date = String(req.body?.purchase_date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse(400, 'The purchase date must be a date.');
      const book = db.prepare(`SELECT us.copy_id AS id, us.purchased_by FROM user_statuses us
        JOIN copies c ON c.id = us.copy_id
        WHERE us.copy_id = ? AND c.library_id = ? AND us.user_id = ? AND us.status = 'wishlist'`)
        .get(Number(req.body?.book_id), wl.library.id, wl.uid);
      if (!book) return refuse(404, 'That book is not on this wishlist.');
      if (book.purchased_by) return refuse(409, 'Somebody already purchased that one.');
      // The purchase is recorded against the WISHER's row: it is their wish
      // that is now spoken for, whoever is looking.
      db.prepare('UPDATE user_statuses SET purchased_by = ?, purchase_date = ? WHERE copy_id = ? AND user_id = ?')
        .run(viewer.email, date, book.id, wl.uid);
      res.redirect(303, back);
    });
}
