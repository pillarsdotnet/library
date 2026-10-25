# 📚 Home Library

A self-hosted web app to catalogue the books in your private library, or in
several: one server holds any number of libraries, each with its own books,
shelves, genres, series and members. Works from
any phone or desktop browser (Android + iPhone), scans ISBN barcodes with the
camera, auto-fills metadata from Open Library / `ISBNdb` / Google Books /
Library of Congress / Barnes & Noble, tracks where each
book physically lives, and calculates how many books fit on each shelf.

No native app required — barcode scanning runs client-side in the browser
(via [`html5-qrcode`](https://github.com/mebjas/html5-qrcode)), so it works on
both iOS Safari and Android Chrome.

## Features

- **ISBN scan & auto-fill** — point your camera at the barcode; title, author,
  publisher, page count, cover image, and (when available) physical dimensions
  are pulled from **Open Library** first and then the fallbacks, fastest
  first — **`ISBNdb`** (for a library with a key), **Google Books**, the
  **Library of Congress**, **Barnes & Noble** — each consulted only for the
  blanks the ones before it left. See
  [ISBN lookup sources](#isbn-lookup-sources--the-google-books-quota).
- **Physical description** — hardback/paperback/stapled (comic books and cheap
  magazines)/e-book/audiobook, dust-jacket
  present/missing/N/A, and book dimensions (height × width × spine thickness).
- **Genre / subgenre** with autocomplete from what you've already entered.
  Genres follow a series both ways, each time with a prompt first: leaving the
  series field after naming one offers to take on the genres its other books
  carry, and saving a series member whose genres differ from the rest offers
  to spread the difference to the other books (added to them, never replacing
  what they have).
- **Wish lists** — the `wishlist` status puts a book on your own wish list
  (yours, not the library's), which has a shareable page where visitors can
  quietly mark a book as purchased, signing in along the way if they were not
  already — kept secret from you until the purchase date has passed. See
  [Wish lists](#wish-lists).
- **Shelves as real objects** — model each shelf with room, bookcase, label,
  grid **cell** (its spot in the bookcase: column letter + row number, A1 top
  left — separate from the label, which stays free text like "Horror" or a
  branch name), and dimensions (height × width × depth). Books are placed _on_
  a shelf. **Add bookcase** creates a whole rows × columns grid of shelves at
  once, and after you measure one shelf the app offers to copy the depth to the
  whole bookcase, the width down its column, and the height across its row.
- **Visual bookcases** — a bookcase whose shelves have cells is drawn as the
  table those cells describe, each book a spine scaled from its real (or
  presumed) dimensions and colored by averaging the left border of its cover
  image (grey when there is no cover). The spine is a two-celled mini-table —
  title above, author below, both written down the spine in whichever of black
  or white reads better, word-wrapped and shrunk to fit so nothing is ever
  truncated (zoom in for the tiny ones); each book independently gets the
  largest size that fits, and the fitted typography is cached per copy and
  recomputed only when the book, its shelf, or the shelf's size changes.
  Unmeasured books are
  presumed the average size of the library's other hardbacks or softcovers.
  The bookcase's own color — picked from a grid of standard colors, or scanned
  by photographing the real bookcase and averaging the photo's pixels — backs
  the table; unset means white.
- **Move, rename or copy a bookcase** — click a bookcase's name on the Shelves
  tab and give it a room and a name. **Edit** moves or renames it: every shelf
  in it, and every book on them, goes along, and naming a bookcase that already
  exists in that room merges the two. **Copy** makes a new bookcase with the
  same shelves (labels, dimensions, notes) and none of the books; the copy must
  not already exist.
- **Capacity & reorganizing help** — each shelf shows a fill bar, how much space
  is used vs. free, roughly how many more books fit, and warns about books that
  are **too tall** or **too deep** for the shelf. The book editor warns you if a
  book won't fit the shelf you're assigning it to.
- **Status** — To be read / Reading / Read / Loaned out (with borrower name) /
  `wishlist`. **Status is yours, not the book's**: each member of a library keeps
  their own — a book one person has read can still be to-be-read for the next,
  and a book you add starts as to-be-read for everyone else.
- **Library books** — flag books you've checked out from a public library and
  track the library name and due date. Filter to **just the borrowed ones, ordered
  by due date** (soonest first, undated last), or to **overdue only** — the list
  answers "what do I owe the library, and when" rather than making you hunt.
- **Search & filter** by text, status, library/overdue, format, genre, series, room,
  bookcase, or shelf (incl. `Unshelved`). Filters compose. While filtering to a
  shelf, **Add book** starts with that shelf chosen.
- **Filed like a library** — every listing, on a shelf or in a search, orders by
  the primary author's surname then given and middle names (any suffix and the
  co-authors tie-break), then series title (a standalone
  book files under its own title), then position in the series, then title with
  the leading article skipped, then binding (`ebook`, `hardback`, `paperback`,
  `stapled`).
  Filtering to one series switches to reading order, and the borrowed-books
  filter to due date, as above.
- **Give back to Open Library** — measurements, binding, page count and cover
  photos from your own copies can fill gaps in Open Library's records, through a
  review queue where you approve each one, sent under your own Open Library keys.
  See [Contributing back to Open Library](CONTRIBUTING.md#contributing-back-to-open-library).
- **Many libraries, one server** — signing in names a library; a new name starts
  a new one. See [Libraries and members](#libraries-and-members).

## Installing

[INSTALLING.md](INSTALLING.md) covers installing and running the app — the
Debian package, Docker, plain Node and the environment it reads — plus the
two-node failover, HTTPS for camera scanning, and the API.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the data model, the pre-commit
hooks, the versioning and dependency rules, and contributing metadata back to
Open Library.

## Access control

With sign-in on (see [Signing in](#signing-in)), every page and API route needs a
Google account that is a **member** of the library the session was opened for,
checked on every request. With sign-in off there are no accounts: whoever can
reach the port can read and edit the first library, which only suits a private
network (`Tailscale`, a VPN, a LAN you trust).

Sign-in is what makes a public address possible. Even then:

- **New libraries are open to anyone with a Google account.** Naming an unused
  library at sign-in creates it. That is by design, and it means strangers can
  store books on your server; every library is isolated from the others, except
  that the server's owner is a member of all of them and is emailed about each
  new one (see [Libraries and members](#libraries-and-members)).
- **Open Library keys belong to people, not to the server.** Each user adds
  their own, and only someone with verified keys sees Give back, so nobody can
  write to a public catalogue under another person's account.
- **Bind it to somewhere deliberate.** The Debian package listens on a Unix
  socket and lets `nginx` be the only thing that listens outward (see
  [INSTALLING.md](INSTALLING.md)), which is a good default to copy.

## Signing in

Google says who you are; the app's own `users` and `library_users` tables say
what you may open. Or, with sign-in off, it asks nobody — and which of those it
is doing is printed on every boot:

```text
   sign-in OFF — anyone who can reach this port can edit the library
```

**Sign-in is off until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.**
That default is deliberate: a missing variable leaving a home server open is
recoverable, and a missing variable locking everyone out of the machine that
holds the library is not. The banner is there so "open" is always a choice.

To turn it on, create an `OAuth` client (Google Cloud console → `APIs & Services` →
Credentials → **Web application**), and register the callback as an authorized
redirect URI — `https://your-host/auth/callback`, or with `BASE_PATH` set,
`https://your-host/library/auth/callback`. One client can carry a redirect URI
for each host the app answers on. Then:

```bash
GOOGLE_CLIENT_ID=….apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
SESSION_SECRET=$(openssl rand -hex 32)   # or every restart signs everyone out
TRUST_PROXY=true                         # behind nginx, so cookies can be Secure
```

`/healthz` is the one route in front of the gate, and it has to be: the deploy
and failover scripts claim the floating IP only when the app answers `200`, and
a probe has no account to sign in with. Point any monitoring at that path rather
than at `/`.

The web app manifest and the icons it lists are open too. A browser fetches the
manifest without the session cookie, and Android fetches the icons from Google's
servers when it installs the app, so behind the gate "Add to Home screen" gets
nothing. None of them says anything about the library.

With those set, every other page and API route needs a member of the session's
library. A browser is sent to the sign-in form at `/auth/login`; anything else
gets `401` and that URL, so a `fetch` reports "sign in required" rather than
trying to parse a sign-in page as JSON. The form asks for the **library name**,
then hands over to Google. Sign out at `/auth/logout` (or from the ⚙ Account
screen); `/auth/me` says who is signed in, and to which library.

### How long a sign-in lasts

The timeout is an **idle** one, not a lifetime: ten days without a visit, and
every visit pushes the expiry back out to ten days. So anyone who opens the
library even occasionally is never asked to sign in again, and an account that
stops being used is signed out ten days later. The cookie is only re-issued once
a session is past its half-life, so ordinary browsing does not put a `Set-Cookie`
on every stylesheet.

A session also ends early when its user stops being a member of its library, at
`/auth/logout`, or if `SESSION_SECRET` changes — which is why the two nodes must
share one, or a failover would look like a mass sign-out. Nothing on Google's
side expires it: no refresh token is ever requested, and the `id_token` is read
once and discarded.

## Libraries and members

Signing in names a library, and the header then says whose it is: a user in the
`Bobbalisa` library sees **`📚 Bobbalisa Library`**. (A name that already ends in
"Library" is not given a second one.)

- **A name nobody has used creates a library**, with the person signing in as
  its founding member and its own copy of the starter genres. Names are matched
  ignoring case and extra spaces, and are 1 to 60 characters.
- **A name in use admits its members and nobody else.** The refusal names the
  address and the library, since the usual cause is the wrong Google account or
  a typo in the name.
- **One library at a time.** The session carries the library it was opened for.
  To use another, sign in again naming it (**Switch library** on the ⚙ Account
  screen); the form lists the libraries you belong to.
- **The form remembers you.** Signing in leaves a year-long `hl_last` cookie with
  your address and library, so the form is filled in next time and Google offers
  the same account first. Signing out keeps it.
- **Members are managed on the Users tab**, shown to anyone who founded a
  library. It lists **every library you founded** — whichever one you are
  signed in to — and, for the server's owner (user 1), **every library the
  server hosts**. For each: who may sign in, with the founder and owner
  marked; add an address; edit one in place (fixing a typo moves the
  membership to the corrected address); or remove it. Removing yourself, the
  owner, or the last member, is refused. Membership is checked on every
  request, so a removed member is out on their next click.
- **The owner is in every library.** User 1, the first account the database
  held, is added to each library as it is created, and to every existing one.
  The Members screen marks them **(owner)**.
- **The owner hears of every new library.** With `SMTP_USER` and
  `SMTP_PASSWORD` set, creating a library emails the owner its name, who
  started it, and the sign-in link. The app submits to Gmail itself on port 587
  and will not send the password unless the connection is upgraded with
  STARTTLS and the certificate checks out. A failed send is logged; it never
  holds up the sign-in. The startup log says whether this is on.

The first library, **`Bobbalisa`**, is created automatically, and everything in a
database from before libraries belongs to it. So do the addresses in
`allowed-emails.txt` beside the database: they become its members, once, when
it is created. The file is not read after that.

A session from before libraries names none; it is honoured for members of the
first library, the only one there was, and re-issued naming it.

## Wish lists

A book whose status is `wishlist` sits on _your_ wish list: statuses are each
member's own, so the wish belongs to the person who set it, not to the library.

Each list has a readable address naming the library and the person —
`wishlist/<library>/<email>`, so `wishlist/bobbalisa/lghvincent@gmail.com` —
or the library's name alone on a server running without sign-in, where there
are no accounts. Library names and emails are case-preserving but match
case-insensitively, here as everywhere else, so any casing of the address finds
the same page; the app offers the lower-case spelling for sharing.

Filtering the Books tab to the `wishlist` status shows your list and its
shareable address. Clicking the address copies it to the clipboard — it
deliberately does not open the page, which is for other people, and might hold
a spoiler meant for them. Share it however you like:

- **Anyone holding the URL may look** — no account, no sign-in — and only look.
  The page offers no way to edit anything.
- **Every visitor who is not the list's owner** gets a **🎁 Purchase** button
  on each book. Signed in, it asks for a purchase date and records it with the
  buyer's own address; the record then replaces the button, so nobody buys a
  second copy in good faith. A visitor who is not signed in is first led
  through sign-in — library name and Google account; any library they belong
  to counts, and a new name founds their own — and comes back to the list with
  that book's date form open. Refusing to sign in just returns to the list,
  with nothing recorded.
- **The owner is told nothing until the purchase date has passed.** The server
  withholds the buyer and the date from every response to the owner until
  then, so the surprise never even reaches their browser; afterwards the book's
  card and dialog say who bought it and when. Signed-in visitors see the full
  record; strangers with the URL see only that the book is spoken for, never
  the buyer's address.

Taking a book off the wish list retires the entry, purchase record and all;
putting it back on starts a fresh wish that can be bought again.

## ISBN lookup sources & the Google Books quota

Lookups draw on five sources. **Open Library is always first** — it is the
source this app contributes back to — and the fallbacks run fastest first
(measured over a sample of books already in the library with
[`bench/lookup-sources.mjs`](bench/lookup-sources.mjs)),
each consulted **only if a field it could supply is still blank**, stopping as
soon as the record is complete:

1. **Open Library** — always consulted first.
2. **`ISBNdb`** — only for a library whose founder has stored a key (see
   below): keyed and metered, but the fastest fallback measured and the one
   with the deepest coverage, dimensions and binding included.
3. **Google Books** — title, author, publisher, date, page count, cover,
   dimensions; it has no binding.
4. **Library of Congress** — title, author, publisher, date, page count, spine
   height. The catalog's SRU gateway is free and keyless and reaches plenty of
   books the commercial sources miss, but it carries no cover, no binding, and
   only the one dimension MARC records.
5. **Barnes & Noble** — cover and binding included, but no dimensions. This is
   a page scrape, so it runs last and only when it might actually help.

**API keys belong to the library.** The Google Books and `ISBNdb` keys are
stored per library — sealed at rest like every stored credential — and the
Account dialog shows a **Lookup keys** form to the library's founder alone;
even the founder is shown only a hint of a stored key, never the key back. A
server-wide environment variable (`GOOGLE_BOOKS_API_KEY`, `ISBNDB_API_KEY`)
serves as the default for libraries that store none.

Each source fills only the blanks the previous ones left, so a book Open Library
describes completely costs a single request. Series information comes from Open
Library alone.

**Every result is cached** (see the `LOOKUP_*` variables in [INSTALLING.md](INSTALLING.md)): a re-scan, a
retry, or a second look at the same book is served from the cache without
spending another query. A found result is kept 30 days, a "not found" at least
24 hours. When a source is rate-limited, the cache is used in preference to
failing — stale metadata beats none. Add `?refresh=1` to a lookup to force a
re-fetch.

Open Library doesn't have every book, and **keyless Google Books has a very
small shared daily quota** — when it's exhausted the API returns HTTP 429, and a
book that's only on Google Books will fail to auto-fill (the app says it's
rate-limited rather than "not found"). A free Google Books API key raises the
quota to ~1,000 lookups/day and makes this reliable. The hosts can be overridden
(`OPENLIBRARY_BASE`, `GOOGLE_BOOKS_BASE`, `LOC_BASE`, `BARNESNOBLE_BASE`) for a
mirror or a test double; they default to the real services.

### Obtain a key (free, no billing required)

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and sign in.
2. Create a project (top bar → project dropdown → **New Project**), or reuse one.
3. Enable the API: **`APIs & Services` → Library → search "Books API" → Enable**
   (a.k.a. "Google Books API"). It has a free daily quota; no billing needed.
4. Create the key: **`APIs & Services` → Credentials → Create credentials → API key**.
   Copy the key. Recommended: **Edit API key → API restrictions → restrict to
   "Books API"** so the key can't be used for anything else.

### Install the key

**`systemd` node:** add it to `/etc/home-library/home-library.env`, then restart the
unit (`sudo systemctl restart home-library`).
Rotating a key is the same edit followed by the same restart.

**Docker / local:** pass it as an environment variable:

```bash
GOOGLE_BOOKS_API_KEY=YOUR_KEY npm start
# docker run: add  -e GOOGLE_BOOKS_API_KEY=YOUR_KEY
```

## Notes

- Deleting a shelf keeps its books; they become `Unshelved`.
- ISBN dimension data is sparse in both sources — when it's missing, measure the
  book and enter height/width/thickness by hand to enable shelf-fit calculations.

## License

GNU General Public License, version 3 or (at your option) any later
version; see [`LICENSE`](LICENSE).
