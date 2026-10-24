# 📚 Home Library

A self-hosted web app to catalogue the books in your private library, or in
several: one server holds any number of libraries, each with its own books,
shelves, genres, series and members. Works from
any phone or desktop browser (Android + iPhone), scans ISBN barcodes with the
camera, auto-fills metadata from Open Library / Google Books / Library of
Congress / Barnes & Noble, tracks where each
book physically lives, and calculates how many books fit on each shelf.

No native app required — barcode scanning runs client-side in the browser
(via [`html5-qrcode`](https://github.com/mebjas/html5-qrcode)), so it works on
both iOS Safari and Android Chrome.

## Features

- **ISBN scan & auto-fill** — point your camera at the barcode; title, author,
  publisher, page count, cover image, and (when available) physical dimensions
  are pulled from **Open Library**, then **Google Books**, then the
  **Library of Congress**, then **Barnes & Noble**, each consulted only for
  the blanks the ones before it left (Barnes & Noble has no API, so its public
  product page is scraped, and only as the last resort — it is also the
  fallback that can supply the binding, which neither Google Books nor the
  catalog carries).
- **Physical description** — hardback/paperback/e-book/audiobook, dust-jacket
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
- **Give back to Open Library** — measurements, binding, page count and cover
  photos from your own copies can fill gaps in Open Library's records, through a
  review queue where you approve each one, sent under your own Open Library keys.
  See [Contributing back to Open Library](#contributing-back-to-open-library).
- **Many libraries, one server** — signing in names a library; a new name starts
  a new one. See [Libraries and members](#libraries-and-members).

## Data model

SQLite — see [`db.js`](./db.js). Book data is split along the ISBN:

| Table                    | Holds                                                                                                                   | Why                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `editions`               | Title, authors, publisher, published date, page count, **format**, **dimensions**, stock cover artwork, metadata source | Everything an ISBN determines, and therefore identical for every copy     |
| `copies`                 | Dust jacket, shelf, loan, library borrowing + due date, notes, a photograph of _this_ copy                              | Everything true of one physical object on one shelf                       |
| `user_statuses`          | Each member's own reading status per copy, and the wish-list purchase made against it                                   | Status is personal: one member's "read" is the next member's "to be read" |
| `shelves`                | Room, bookcase, label, grid cell, bookcase color, clearances                                                            | Where copies live                                                         |
| `libraries`              | Name                                                                                                                    | A tenant: everything above belongs to exactly one                         |
| `users`, `library_users` | Email address and encrypted Open Library keys; who belongs to which library                                             | Who may sign in to what                                                   |

Every table a library owns carries its `library_id`: shelves, editions, copies,
genres, series and Open Library proposals. The link tables (`book_genres`,
`series_books`, `ol_send_attempts`) belong to a library through the rows they
link. Triggers make the database refuse a row with no library, a row that moves
to another library, and a link between two libraries' rows (a copy on another
library's shelf, a genre under another library's genre), so a query that
forgets its library fails loudly instead of mixing two. Uniqueness is per
library too: two libraries may each own the same ISBN or each have a genre
called Fantasy. The ISBN lookup cache is the one thing shared, because it holds
only what the metadata services said about an ISBN.

Format and dimensions are **edition** data, which surprises people: a hardback
and a paperback of one book carry a _different ISBN each_, so the ISBN settles the
binding and the size. Of the edit form's "Physical" group, only the dust jacket
is per-copy — your copy lost its jacket, mine did not.

Genres, series membership and Open Library proposals hang off the **edition**:
two copies of one book are one book, tagged once and queued once. Editions also
carry `ol_work_id`, unused today — it is the anchor for moving genres and series
up to _work_ level later (Open Library keeps the series tag on the work, `OL…W`,
and the rest on the edition, `OL…M`) without another table split.

`books` is a **read-only view** joining a copy to its edition, so every query and
API response looks as it always did; `library_name` is an alias of
`copies.borrowed_from`. Writes must name `editions` and `copies` — SQLite reports
`lastInsertRowid` 0 and `changes` 0 for writes through a view, so a write there
would look like success while doing nothing.

Every ISBN is stored canonically as ISBN-13, so the 10- and 13-digit spellings of one
book cannot become two records. Check digits are verified: an ISBN that fails is
kept for display but never used to match, because merging on an unverifiable
value would fuse two unrelated books.

An edition is keyed on **`(library_id, isbn13, format)`**, not on the ISBN alone. E-books
have an ASIN rather than an ISBN, and importers routinely staple the print ISBN onto
the e-book record — so matching on the ISBN alone merges a Kindle file into a
hardback, and one of them loses its format and inherits the other's physical
dimensions. Two records must agree on what kind of object they are before they
are treated as the same edition.

All physical dimensions are stored in **millimetres**. Capacity is computed by
treating each book's _spine thickness_ as the width it consumes along the shelf;
a book fits if its height ≤ shelf height and its width ≤ shelf depth.

### Covers are files

A photographed cover is a **file** in a `covers/` directory beside the database,
named after the copy it belongs to. The row holds only that filename and
`cover_token`, a hash of the bytes.

**A copy of `library.db` on its own is therefore not a backup.** Every row
naming a missing file is a broken picture, so the covers directory has to travel
with it. Both mechanisms here already do: the handoff moves it through the
`covers-send`/`covers-recv` verbs, and the hourly sync carries it alongside with `rsync`.

The API returns a cover as a reference to `api/books/:id/cover?v=<token>`, never
as bytes. The token is what makes the URL change when the image does — without
it a browser holding a cached copy goes on showing the old photo after a new one
is saved, which looks exactly like the save having failed. Because a versioned
URL names one particular image forever, it is served `immutable`.

Queries that return books select an explicit column list (`BOOK_SELECT` in
`server.js`) rather than `b.*`. That mattered enormously when the images were in
the row — putting one back cost about 4× the throughput of every listing — and
it is still how the query stays honest about what it reads.

### Upgrading from 2.x

The 3.0.0 migration runs on first start and is **one-way** — a database it has
touched cannot be read by 2.x. Copies keep their old book ids, so existing
`/api/books/:id` links still resolve. Back the database up first; the split
merges any copies whose ISBN spellings canonicalise to the same value, taking the union of their
genres and collapsing duplicate Open Library proposals.

## Development: pre-commit hooks

The repository ships [pre-commit](https://pre-commit.com/) hooks that lint on
every commit:

- **`eslint`** and **`stylelint`** — the JavaScript and CSS, via `npm run lint`
- **`prettier`**, **`markdownlint`** and **`vale`** — the Markdown
- **`prettier`** and **`yamllint`** — the YAML
- **`check:deps`**, the asset-version check and the changelog check described
  in the next two sections

Enable them once after cloning — `npm ci` first, because the lint hook runs
`eslint` and `stylelint` out of `node_modules`:

```bash
npm ci
pip install pre-commit        # or: pipx install pre-commit
pre-commit install
```

Run them against everything on demand:

```bash
pre-commit run --all-files
```

Hook versions are pinned in
[`.pre-commit-config.yaml`](.pre-commit-config.yaml) and can be bumped with
`pre-commit autoupdate`; prose and YAML settings live in
[`.vale.ini`](.vale.ini) and [`.yamllint`](.yamllint).

## Changing CSS or JS: bump the version

`index.html` requests every stylesheet and script with `?v=<version>`, filled in
from `package.json` when the page is served. **The version is the only thing that
makes a browser fetch those files again.**

So: **any change to `public/*.css` or `public/*.js` needs a version bump in
`package.json`**, plus a line in [`CHANGELOG.md`](./CHANGELOG.md). The
`pre-commit` hook enforces this and explains itself if you forget; `--no-verify`
skips it for changes that genuinely reach no browser.

This is not fussiness. `index.html` is revalidated on every load, but a phone
will happily go on using a cached `styles.css` for days without asking — so a
deployed fix can be invisible on the one device that reported the bug, which is
indistinguishable from the fix not working. That has already happened here once.

Semantic versioning, judged from the user's side: **patch** for a fix, **minor**
for a feature, **major** when a database written by the new build can no longer
be read by the old one.

## Dependencies: no vulnerabilities, no deprecations

`npm run check:deps` fails if `npm audit` reports a vulnerability of any
severity, in runtime or development dependencies, or if any installed package
version is deprecated. The `pre-commit` hook runs it, and so does the
CI **Lint and syntax check** job, which the `main` branch `ruleset` requires.

Deprecations are looked up in the `npm` registry for every version in
`package-lock.json`, not taken from `npm ci`'s warnings. Those warnings only
repeat what the `lockfile` recorded when a package was resolved, so a package
deprecated later passes `npm ci` in silence. The lookup takes a second or two
and needs the network; offline, commit with `--no-verify` and let CI check.

`@ericblade/quagga2` bundles its own `sharp` for use under Node.js; the
`overrides` entry in `package.json` moves it onto ours. The scanner never loads
it — the browser gets the library's prebuilt `dist/` — but `npm audit` counts it.

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
- **Bind it to somewhere deliberate.** The `systemd` unit described below
  publishes the container port on `127.0.0.1` and lets `nginx` be the only thing
  that listens outward, which is a good default to copy.

## Run it

### From the Debian registry

On Ubuntu 26.04 (`resolute`) or 26.10 (`stonking`), install the Debian package
from the
[package registry](https://forgejo.bobbalisa.org/pillarsdotnet/-/packages) on
`forgejo.bobbalisa.org`:

```sh
sudo install -d /etc/apt/keyrings
curl -fsS https://forgejo.bobbalisa.org/api/packages/pillarsdotnet/debian/repository.key |
  sudo tee /etc/apt/keyrings/forgejo-bobbalisa.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/forgejo-bobbalisa.asc] https://forgejo.bobbalisa.org/api/packages/pillarsdotnet/debian $(lsb_release -cs) main" |
  sudo tee /etc/apt/sources.list.d/forgejo-bobbalisa.list > /dev/null
sudo apt update
sudo apt install home-library
```

The package runs the app as a `systemd` service, started on demand through a
Unix socket, and ships an `nginx` snippet and an Apache configuration that serve
it under `/library/`. Its data lives in `/var/lib/home-library`, and its
settings in `/etc/home-library/home-library.env`. The registry also carries the
newer `libvips` it needs, and on 26.04 the Node.js 24 that the archive lacks.
`/usr/share/doc/home-library/README.Debian` covers the web server setup.

To run one library on two machines, with exactly one of them accepting changes
at a time, add `home-library-failover` (26.10 only). It hands the
live database and covers between the two, moves a `Tailscale` floating address
with them, and can point a public DNS name at whichever machine is serving.
Nothing changes until `home-library-failover enable`; see
`/usr/share/doc/home-library-failover/README.Debian`.

### With Docker

```bash
docker compose up -d --build
```

Then open `http://<your-server>:3000`. The image is built locally from the
[`Dockerfile`](Dockerfile) (Debian slim; the `zoneinfo` files are included, so
due dates follow `TZ` instead of silently meaning UTC). The SQLite database is
stored in the `library-data` Docker volume, so it survives rebuilds. To back it
up, copy `/data/library.db` **and the `covers/` directory beside it** out of
the volume — neither is whole without the other.

The scripts in [`bench/`](bench/) compare any two images (memory, CPU per
request, image size), such as two releases, or slim with and without
`MALLOC_ARENA_MAX=2`.

### With Node directly

```bash
npm install
npm start            # http://localhost:3000
```

Environment variables:

| Variable                    | Default                       | Purpose                                                                                                                 |
| --------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`                      | `3000`                        | HTTP port, when neither of the next two applies                                                                         |
| `SOCKET_PATH`               | _(none)_                      | Listen on this Unix socket instead of `PORT`, for a web server in front; a stale socket file there is removed first     |
| `SOCKET_MODE`               | _(`umask`)_                   | Octal mode for that socket, e.g. `660` so the web server's group can connect                                            |
| `LISTEN_FDS`                | _(set by `systemd`)_          | A socket handed over by `systemd` socket activation wins over both; the Debian package runs it this way                 |
| `DB_PATH`                   | `./data/library.db`           | SQLite file location                                                                                                    |
| `BASE_PATH`                 | `` (root)                     | Sub-path to serve under, e.g. `/library`                                                                                |
| `GOOGLE_BOOKS_API_KEY`      | _(none)_                      | Optional; raises the Google Books lookup quota                                                                          |
| `OPENLIBRARY_ACCESS_KEY`    | _(none)_                      | Sign-in **off** only: the keys contributions are sent with. With sign-in on, each user adds their own                   |
| `OPENLIBRARY_SECRET_KEY`    | _(none)_                      | Paired with the access key                                                                                              |
| `OPENLIBRARY_ALLOW_IMPORT`  | _(unset)_                     | `true` allows creating records for books Open Library lacks                                                             |
| `OPENLIBRARY_SOURCE_PREFIX` | `pillarsdotnet_library`       | `source_records` prefix for imports; set it empty to stamp nothing and import nothing                                   |
| `GOOGLE_CLIENT_ID`          | _(none)_                      | Google `OAuth` client; **setting this and the secret is what turns sign-in on**                                         |
| `GOOGLE_CLIENT_SECRET`      | _(none)_                      | Paired with the client id                                                                                               |
| `AUTH_ALLOWED_FILE`         | `<DB dir>/allowed-emails.txt` | Read **once**, when the first library is created: its addresses become that library's members                           |
| `SESSION_SECRET`            | _(new each boot)_             | Signs session cookies and encrypts users' Open Library keys; set it, or a restart signs everyone out and loses the keys |
| `SESSION_IDLE_DAYS`         | `10`                          | Sign-in expires after this long **without a visit**; every visit pushes it out (floored at 1 day)                       |
| `OAUTH_REDIRECT_URI`        | _(from the request)_          | Override when the public URL is not what the app sees                                                                   |
| `PUBLIC_ORIGIN`             | _(from the request)_          | Scheme and host to build the redirect URI and emailed links from                                                        |
| `SMTP_USER`                 | _(none)_                      | Gmail address the new-library email is sent from; **setting this and the password turns it on**                         |
| `SMTP_PASSWORD`             | _(none)_                      | A Gmail app password for `SMTP_USER`                                                                                    |
| `SMTP_HOST`                 | `smtp.gmail.com`              | Submission server; must offer STARTTLS                                                                                  |
| `SMTP_PORT`                 | `587`                         | Submission port                                                                                                         |
| `TRUST_PROXY`               | _(off)_                       | `true` behind `nginx`, so `X-Forwarded-Proto` decides the Secure cookie flag                                            |
| `LOOKUP_TTL_DAYS`           | `30`                          | How long a found lookup stays cached (floored at 1 day)                                                                 |
| `LOOKUP_NEGATIVE_TTL_HOURS` | `24`                          | How long a "not found" stays cached (floored at 24h)                                                                    |

### Signing in

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

#### How long a sign-in lasts

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

### Libraries and members

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
- **Members are managed on the Users tab**, shown to the library's creator
  alone: list who may sign in, add an address, edit one in place (fixing a typo
  moves the membership to the corrected address), or remove it. Removing
  yourself, the owner, or the last member, is refused. Membership is checked on
  every request, so a removed member is out on their next click.
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

### Wish lists

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

### ISBN lookup sources & the Google Books quota

Lookups draw on four sources, **in order, stopping as soon as the record is
complete**:

1. **Open Library** — always consulted first.
2. **Google Books** — only if a field it could supply is still blank (title,
   author, publisher, date, page count, cover, dimensions; it has no binding).
3. **Library of Congress** — only if a field it could supply is still blank
   (title, author, publisher, date, page count, spine height). The catalog's
   SRU gateway is free and keyless and reaches plenty of books the commercial
   sources miss, but it carries no cover, no binding, and only the one
   dimension MARC records.
4. **Barnes & Noble** — only if a field it could supply is still blank (cover
   and binding included, but no dimensions). This is a page scrape, so it runs
   last and only when it might actually help.

Each source fills only the blanks the previous ones left, so a book Open Library
describes completely costs a single request. Series information comes from Open
Library alone.

**Every result is cached** (see the `LOOKUP_*` variables above): a re-scan, a
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

#### Obtain a key (free, no billing required)

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and sign in.
2. Create a project (top bar → project dropdown → **New Project**), or reuse one.
3. Enable the API: **`APIs & Services` → Library → search "Books API" → Enable**
   (a.k.a. "Google Books API"). It has a free daily quota; no billing needed.
4. Create the key: **`APIs & Services` → Credentials → Create credentials → API key**.
   Copy the key. Recommended: **Edit API key → API restrictions → restrict to
   "Books API"** so the key can't be used for anything else.

#### Install the key

**`systemd` node:** add it to `/etc/home-library.env`, which the `systemd` unit passes
to the container, then restart the unit (`sudo systemctl restart home-library`).
Rotating a key is the same edit followed by the same restart.

**Docker / local:** pass it as an environment variable:

```bash
GOOGLE_BOOKS_API_KEY=YOUR_KEY npm start
# docker run: add  -e GOOGLE_BOOKS_API_KEY=YOUR_KEY
```

`BASE_PATH` makes the whole app (UI + API) live under a sub-path. The server
injects a matching `<base href>` so every asset and API call is relative — the
app works at `/` or under any prefix with no rebuild.

## Contributing back to Open Library

Most of this app's metadata comes from Open Library, which is volunteer-run and
patchy on exactly the things a physical shelf knows: how big the book is, how
it's bound, how many pages it actually has. **↑ Give back** in the header finds
those gaps and offers to fill them.

Two rules govern the whole feature:

1. **Only blanks are ever offered.** If Open Library records a value, it is left
   alone — even when yours differs. A disagreement is not a correction.
2. **Nothing is sent without approval.** Proposals sit in a queue; approving one
   sends it, skipping one retires it for good.

Page count is the field where "missing" and "different" are most easily
confused, since editions legitimately differ on what counts. This app's
convention is **the highest explicitly numbered page, disregarding unnumbered
pages**, and every page-count contribution says so in its edit comment.

**Series** follows Open Library's contributors' guide, which puts a series on
the _work_ as a tag written `[series:series_name]` on the edit form — the
brackets are form syntax, and what is stored is a plain subject string,
`series:Discworld`, which is what drives the `/subjects/series:…` pages. So the
series contribution edits the work record, not the edition, and it is offered
only when the work carries no series tag at all.

That sanctioned form has nowhere to put a **position**, so the order within a
series is never sent. A book's membership of a series is a fact about the work;
its number is a convention (publication order, chronological order, whether
novellas count) that Open Library's series tag does not model, and this app does
not invent a place for it.

### Set up an account (one-time)

Contributions are attributed to an account, and automated edits need a **bot**
account, separate from your personal one.

1. **Create the account.** Register at
   [openlibrary.org](https://openlibrary.org/account/create) with a username
   ending in `Bot` — the suffix is required, and lets Recent Changes separate
   automated edits from human ones.
2. **Request API write access — this one is not optional.** Editing Open Library
   _through the website_ needs no approval; any confirmed account can do it, and
   librarian status only adds merging and collections. **Editing through the API
   is gated separately.** The `Infogami` REST handler calls `can_write()` on every
   PUT, and Open Library overrides it to allow only accounts with the bot flag,
   site admins, and members of `/usergroup/api`
   ([code.py](https://github.com/internetarchive/openlibrary/blob/master/openlibrary/plugins/openlibrary/code.py),
   [`infogami` API](https://github.com/internetarchive/infogami/blob/master/infogami/plugins/api/code.py)).
   Without it every metadata edit here returns **403 Forbidden**, no matter how
   legitimate.

   So open an issue on the
   [`openlibrary` repository](https://github.com/internetarchive/openlibrary/issues)
   asking a site admin to grant bot privileges and add the account to the `API`
   `usergroup`. Say what the bot will edit and how often; ours fills empty
   `physical_dimensions`, `physical_format` and `number_of_pages` fields, adds a
   `series:` subject tag to works that have none, and uploads covers for
   editions that have none, all at human-review pace. Expect this
   to take a few days — it is a manual review by a volunteer.

   **Covers are the exception.** `/books/OL…M/add-cover` is an ordinary form
   endpoint with no `can_write()` check, so cover uploads should work as soon as
   the account can log in — before the `usergroup` request is granted.

3. **Get the keys.** Signed in as the bot, visit
   [archive.org/account/s3.php](https://archive.org/account/s3.php) and copy the
   access key and secret key. (Open Library authenticates with Internet Archive
   S3-style keys, then hands back a session cookie.)
4. **Add the keys to your account.** Signed in to the app, open ⚙ **Account**
   and paste them under **Open Library keys**. They are checked by signing in to
   Open Library before they are saved, and stored encrypted under a key derived
   from `SESSION_SECRET`: only the last four characters of the access key are
   ever shown again, and a copy of the database is no use without the secret.
   **Give back appears only once your keys are saved**, and everything you send
   goes out under them. Another member of the same library sees Give back only
   with keys of their own.

   With sign-in **off** there are no accounts, so the keys go in the environment
   instead — `/etc/home-library.env` on the node, or locally:

   ```bash
   OPENLIBRARY_ACCESS_KEY=your_access_key
   OPENLIBRARY_SECRET_KEY=your_secret_key
   ```

   and Give back is shown as it always was, sending once they are set.

### Books Open Library has never heard of

Some books — recent small-press titles especially — have no Open Library edition
at all, so there is nothing to contribute to. Those can be _created_ through
`/api/import`, but creating a record is a different act from filling a blank: a
bad edit is one wrong field, a bad import is a duplicate or a phantom book, and
duplicates can only be merged by librarians. So it is off by default:

```bash
OPENLIBRARY_ALLOW_IMPORT=true
OPENLIBRARY_SOURCE_PREFIX=yourbot   # optional; overrides the built-in prefix
```

The prefix names the _catalogue_ a record came from, not the person running the
import — `ia`, `bwb` and `midcolumbia` are the shape of it, and the importer is
already identified by the Open Library account the edit is attributed to. This
installation stamps `pillarsdotnet_library` unless `OPENLIBRARY_SOURCE_PREFIX`
says otherwise; another deployment that has agreed its own prefix with Open
Library sets that variable. Setting it to an **empty** string means "no prefix",
and no prefix means no import — the stamp is not optional, so nothing is
offered without one. A prefix containing a colon, whitespace or a slash would
split or mangle the stamp, and is refused the same way.

With both set, a scan proposes a new record for any ISBN Open Library does not
have, provided the book carries enough to identify it — Open Library accepts
either a complete record (title, authors, publishers, publish date) or a title
plus a strong identifier (ISBN/LCCN), and both need `source_records`.

The `source_records` value is stamped as `<prefix>:<ISBN-13>`, always the
canonical 13-digit form even for a book catalogued by its 10-digit ISBN, so one
edition leaves one mark however it was entered. A book whose ISBN fails its
check digit is not offered for import at all — an unverifiable identifier is not
one to found a new public record on.

> **Cover images have to be uploaded by hand.** Open Library accepts covers
> only through a browser form, and has put its forms behind a human-verification
> challenge; an authenticated upload from a program gets `405` from their front
> end (measured 2026-09-22) — while the same upload from a signed-in person in a
> browser goes through without a challenge at all. So a cover row offers the
> image and a link to the right `add-cover` page rather than a Send button that
> can only fail. Every other field goes through the JSON API and is unaffected.
>
> Save the image **before** opening their form: it opens a file picker, and on a
> phone that picker opens _Photos_ while a saved image lands under
> _Files → Downloads_. The first visit may also be interrupted by their human
> check and leave you on the book page rather than the upload form — tapping the
> same link again goes straight there.
>
> When the upload is done, **3 · Done — check** asks Open Library whether it
> arrived and closes the row if it did. Use that rather than **Skip**: skipping
> records a decision never to offer the book again, and an upload that failed
> silently would disappear with it.

The queue runs the other way too. When a scan finds Open Library has acquired a
cover for an edition you photographed, it proposes adopting theirs: the row
shows both images side by side, and approving it **deletes** the copy's
photograph and its uncropped source, leaving the edition on Open Library's
artwork. That is the only approval that destroys anything — and the only one
that needs no Open Library account, since it sends nothing — so it confirms
first. **Skip**/**Keep mine** leaves the photograph alone.

**⟳ Look for gaps** takes the editions least recently compared against Open
Library, so clicking it repeatedly walks the whole library 25 books at a time
rather than re-reading the same ones. **⟳ Check my photos** narrows the same
sweep to the editions carrying a photograph, whenever they were catalogued.

A send that fails on the network — a dropped connection rather than a refusal —
is retried a few times before the row is marked failed, so a passing blip does
not need a manual retry. A refusal from Open Library (any HTTP status) is taken
at its word and not retried.

The queue lists everything still waiting for a person — proposals not yet acted
on, and ones whose send failed, which carry the reason. `?status=` on
`/api/ol-contributions` narrows it to any set of states.
`/api/ol-contributions/status` adds `coverage`: `books` with an ISBN, how many
are `checked` and `unchecked`, and `last_checked` (UTC).

Approving one runs it **twice**: first with `?preview=true`, which parses,
validates and runs Open Library's own duplicate matching without saving. If the
preview reports the book already matched an existing edition, nothing is
created and the queue says which record it matched. Only a preview that would
genuinely create something proceeds to the real import.

> The bot application filed for this account states that it creates no records.
> Leave `OPENLIBRARY_ALLOW_IMPORT` unset until that scope has been renegotiated
> with Open Library — running beyond an approved scope is how bot privileges get
> revoked.

### Using it

**↑ Give back** appears once your Open Library keys are saved on your account
(always, with sign-in off). It opens the queue; it does not search by itself. **Look for gaps**
checks 25 of your books (never-checked first, then least recently checked)
against Open Library, one request per book, and queues what it finds. Its result
stays on screen, and beneath it the dialog says how many books have been checked
and how lately, how many never have, and how many contributions have been sent.
When every row left has been tried and refused, a note says there is nothing new
to send, so a queue holding only refusals does not look like a broken search.
Each row names the book, the edition it would edit, the field, and the exact
value that would be sent. **Send** submits it; **Skip** retires it.

Sending re-reads the live record first and refuses if the blank has been filled
in the meantime — a queue can sit for days, and someone else may have got there
first.

### On a server

A server runs the Debian package — see
[From the Debian registry](#from-the-debian-registry). Install it with `apt`,
and upgrade or roll back the same way; `systemd` socket activation, `nginx`
setup and the settings file are covered by
`/usr/share/doc/home-library/README.Debian` on the node.

## Two-node failover (optional)

`deploy/failover.sh` and the two units beside it move the app between two nodes, so
exactly one node is writable at a time. **Both nodes run identical units**, so either
one hands the database over when it shuts down — without that, shutting down whichever
node happens to be active strands the only authoritative copy on a powered-off box. The SQLite database
travels with the active node, and a floating address follows it, so clients keep one
URL. It is a **graceful handoff, not high availability** — the shutdown half only
runs on an orderly shutdown, so a power cut leaves the preferred node owning the
database and the standby deliberately does _not_ self-promote.

Which copy is authoritative is decided by an owner marker holding a node name and a
**generation counter**, written on both nodes at every handoff. A push or pull is
refused if the destination's generation is higher, i.e. a later handoff produced it.
File timestamps are logged but never gate a handoff: opening a SQLite database
updates its `mtime`, so a standby started for any reason would otherwise look newer
than the rightful owner and block the next legitimate failover.

Two units bracket the app so that `systemd` — not the script — sequences everything:

| Unit               | Ordering              | Boot                                       | Shutdown                       |
| ------------------ | --------------------- | ------------------------------------------ | ------------------------------ |
| `home-library-db`  | `Before=home-library` | runs first, puts the database in place     | runs last, app already stopped |
| `home-library-vip` | `After=home-library`  | runs last, claims the address once healthy | runs first, withdraws it       |

A hook must never run `systemctl` against the app it brackets — asking `systemd` to
run a job while it is waiting on your `ExecStop` deadlocks until the timeout.

A handoff must also start the receiving node's **own units**, not just its app.
Starting the app directly leaves that node's units inactive while it is serving, and
`systemd` then runs no `ExecStop` on its next shutdown — so it hands nothing back.

The app unit must also **`Requires=`** the database unit on the preferred node.
Ordering alone is not a requirement: without it the app starts even after the
handoff deliberately refused, serves the stale local copy, and the address unit
advertises it — turning "refuse to serve stale data" into "serve stale data as
authoritative".

`PREFERRED` (default `homelab`) breaks the tie, because identical units otherwise
mean a standby that reboots would pull the database from a perfectly healthy active
node and take over. Only the preferred node reclaims on boot; the other comes up
active solely if it already owns the database, i.e. the preferred node handed over
and has not returned. Set it in both units' drop-ins on **both** nodes, alongside
`PEER` and `VIP`; for a public node with a cold backup, prefer the public node, and
promote the backup by hand with `failover.sh to-local` if it has to take over.

Only the node that **owns** the database hands anything over. A standby's database
unit is active too, so its shutdown runs the same `db-release`, and the generation
guard cannot stop it: every handoff writes the same generation to both nodes, and
an equal one passes. So `db-release` checks the owner marker first and does nothing
on a node that does not own the database; without that, a standby going down
pushed its stale copy over the live one.

That same leftover-active unit is why the receiving node's `takeover` verb runs
`db-claim` itself when `home-library-db` is already active. Starting an active unit
runs nothing, so the activity flag was never written and the app was skipped.

`failover.sh to-local` and `to-remote` run each step as a fresh invocation of the
script. The steps inherit the lock the outer run took, rather than taking it again.

A standby boot is a normal outcome, not an error, so it must not leave failed units.
`db-claim` writes an activity flag under `/run` only on the node that should be
running, and the app and address units test it with `ConditionPathExists`, which
makes `systemd` **skip** them cleanly. The flag lives in `/run` deliberately: a reboot
clears it, so every boot has to decide afresh.

Cover images move with the database, through the `covers-send` / `covers-recv`
verbs — they are files beside it, and the two are worthless apart: a row
naming a missing file is a broken picture, and an image nothing refers to is
landfill.

Before a handoff replaces a database, the old one is kept as a timestamped
**copy** (`.backup`, so it is consistent even against an open database), ten
generations deep. Covers are _not_ snapshotted: they are named after the copy
that owns them and are rarely replaced, so a restored database of any recent
vintage still finds its images. These were once hard links, which is not a snapshot at all — a
hard link is another name for the same `inode`, and SQLite writes in place, so every
"generation" tracked the live file and the rotation preserved nothing while
looking exactly like a working backup rotation.

Requirements: `ssh` between the nodes with no password, for a key restricted by
`command=` to `deploy/failover-peer.sh` (a fixed verb list, so the credential cannot
do more than its job), and if the floating address is a mesh-VPN route, an
auto-approver for it — otherwise the standby's advertisement is unapproved and the
address points nowhere for exactly as long as it takes someone to notice.

### Hourly copy to the standby

A handoff only moves the database when someone shuts a node down in an orderly
way. `deploy/db-sync.sh`, run hourly from `/etc/cron.d/home-library-db-sync`,
covers the other case: a node that dies outright then costs at most an hour.

Install it on **both** nodes. It exits immediately unless the node holds the
activity flag, so it follows the database through a handoff rather than naming a
fixed master, and it never pulls — two diverged SQLite databases cannot be merged
afterwards.

It sends the covers directory in the same run — `rsync` is the right tool for that
precisely because almost none of it changes between runs — and writes to
`<data dir>/standby/` on the peer, deliberately **not** to the peer's own
`library.db`: that would drive past the generation interlock, which
exists precisely to refuse replacing a copy a later handoff produced. Restoring
from it is a deliberate act, not something the hourly job can do by accident.

Transport is a second key, pinned on the far side to `rrsync -wo <dir>` so it can
only write and only inside that directory. The failover key is not reused — it is
pinned to the verb script and has no path to `rsync`, which is the point of it.

Per node, `/etc/default/home-library-db-sync` holds `PEER=<other node>`. A run
where nothing has been written since the last one does no work at all; a peer that
is merely offline logs to the journal and exits 0, while anything else fails
loudly.

## HTTPS (for camera scanning)

Browsers only allow camera access over **HTTPS** or on `localhost`, so barcode
scanning needs an HTTPS URL. Any TLS front end works — what matters is that the
certificate is one the phone already trusts, so a self-signed cert is not enough.

Two approaches that need no public DNS:

- **A mesh VPN that issues certs for its own names.** `Tailscale`, for example, can
  obtain and auto-renew a Let's Encrypt cert for a node's MagicDNS name and
  terminate TLS in front of `nginx`:

  ```bash
  # One-time: enable "HTTPS Certificates" in the admin console, then on the node:
  sudo tailscale serve --bg --https=443 http://127.0.0.1:80
  ```

  The app is then reachable at `https://<node>.<tailnet>.ts.net/library/` from any
  device on the VPN.

- **A real domain plus `certbot`**, if the node has one, terminating TLS in `nginx`
  directly.

Such a certificate is only valid for that **one name**, so bare IP addresses and
short hostnames stay on plain HTTP — fine for browsing on a trusted LAN, but use
the certificate's name from a phone when you want to scan.

If TLS is terminated ahead of `nginx` and passed onward over `http`, keep
`absolute_redirect off` on the `/library` redirect (as
[`deploy/nginx-library.conf`](./deploy/nginx-library.conf) does) so the redirect
preserves the client's scheme instead of forcing `https` clients back to `http`.

## API

All endpoints are under `/api`:

- `GET/POST /books`, `GET/PUT/DELETE /books/:id` — filters: `q`, `status`,
  `room`, `genre`, `format`, `shelf_id` (`none` = no shelf).
- `GET/POST /shelves`, `GET/PUT/DELETE /shelves/:id` — list includes computed
  capacity stats (`used_width_mm`, `free_width_mm`, `fill_pct`, `est_additional`,
  `overfull`, `too_tall`, `too_deep`, `unknown_thickness`).
- `PUT /bookcases` — body `{ from: { room, bookcase }, room, bookcase }`: gives
  every shelf in that bookcase the new room and bookcase names. A blank name
  means none.
- `POST /bookcases` — same body: copies every shelf in that bookcase, without
  its books, under the new names. `409` if a bookcase by those names exists.
- `POST /series/:id/genres` — body `{ genre_ids: [...] }`: adds those genres to
  every book in the series (additive; nothing is removed). Backs the two
  copy-across-the-series prompts in the book dialog.
- `GET /lookup/:isbn` — merged Open Library + Google Books + Library of
  Congress + Barnes & Noble metadata, each later source filling only the
  blanks the earlier ones left.
- `GET /meta` — distinct rooms, bookcases, genres for autocomplete + counts.

## Notes

- Deleting a shelf keeps its books; they become `Unshelved`.
- ISBN dimension data is sparse in both sources — when it's missing, measure the
  book and enter height/width/thickness by hand to enable shelf-fit calculations.

## License

GNU General Public License, version 3 or (at your option) any later
version; see [`LICENSE`](LICENSE).
