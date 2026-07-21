# 📚 Home Library

A self-hosted web app to catalogue the books in your private library. Works from
any phone or desktop browser (Android + iPhone), scans ISBN barcodes with the
camera, auto-fills metadata from Open Library / Google Books, tracks where each
book physically lives, and calculates how many books fit on each shelf.

No native app required — barcode scanning runs client-side in the browser
(via [`html5-qrcode`](https://github.com/mebjas/html5-qrcode)), so it works on
both iOS Safari and Android Chrome.

## Features

- **ISBN scan & auto-fill** — point your camera at the barcode; title, author,
  publisher, page count, cover image, and (when available) physical dimensions
  are pulled from **Open Library** and **Google Books**.
- **Physical description** — hardback/paperback/e-book/audiobook, dust-jacket
  present/missing/N/A, and book dimensions (height × width × spine thickness).
- **Genre / subgenre** with autocomplete from what you've already entered.
- **Shelves as real objects** — model each shelf with room, bookcase, label, and
  dimensions (height × width × depth). Books are placed *on* a shelf.
- **Capacity & reorganizing help** — each shelf shows a fill bar, how much space
  is used vs. free, roughly how many more books fit, and warns about books that
  are **too tall** or **too deep** for the shelf. The book editor warns you if a
  book won't fit the shelf you're assigning it to.
- **Status** — To be read / Reading / Read / Loaned out (with borrower name).
- **Library books** — flag books you've checked out from a public library and
  track the library name and due date.
- **Search & filter** by text, status, room, genre, or shelf (incl. "Unshelved").
- **Give back to Open Library** — measurements, binding, page count and cover
  photos from your own copies can fill gaps in Open Library's records, through a
  review queue where you approve each one. See
  [Contributing back to Open Library](#contributing-back-to-open-library).

## Data model

Two tables in SQLite (`shelves`, `books`) — see [`db.js`](./db.js). All physical
dimensions are stored in **millimetres**. Capacity is computed by treating each
book's *spine thickness* as the width it consumes along the shelf; a book fits
if its height ≤ shelf height and its width ≤ shelf depth.

## Access control: there isn't any

**Every endpoint is unauthenticated.** There are no accounts, no login, no
per-user anything. Whoever can reach the port can read the whole library, edit
it, and delete it — and, if Open Library credentials are configured, can send
contributions to a public catalogue under your account.

That is a deliberate fit for the intended deployment — a private network
(Tailscale, VPN, or a LAN you trust) where being able to reach the app *is* the
authorisation — and it is the whole security model. There is nothing else.

So, before putting this anywhere reachable:

- **Do not expose it to the public internet as-is.** Put authentication in front
  of it — HTTP basic auth in the reverse proxy is enough for a household;
  `oauth2-proxy`, Authelia or `tailscale serve` if you want something better.
- **Bind it to somewhere private.** The systemd unit described below publishes
  the container port on `127.0.0.1` and lets nginx be the only thing that
  listens outward, which is a good default to copy.
- **Treat the Open Library keys as the sharp edge.** They turn "someone can
  scribble on my book list" into "someone can write to a public catalogue as
  me". Leave them unset unless you are contributing.

## Run it

### With Docker (recommended for a homelab)

```bash
docker compose up -d --build
```

Then open `http://<your-server>:3000`. The SQLite database is stored in the
`library-data` Docker volume, so it survives rebuilds. To back it up, copy
`/data/library.db` out of the volume.

### With Node directly

```bash
npm install
npm start            # http://localhost:3000
```

Environment variables:

| Variable    | Default              | Purpose                                             |
|-------------|----------------------|-----------------------------------------------------|
| `PORT`      | `3000`               | HTTP port                                           |
| `DB_PATH`   | `./data/library.db`  | SQLite file location                                |
| `BASE_PATH` | `` (root)            | Sub-path to serve under, e.g. `/library`            |
| `GOOGLE_BOOKS_API_KEY` | _(none)_  | Optional; raises the Google Books lookup quota      |
| `OPENLIBRARY_ACCESS_KEY` | _(none)_ | Optional; needed only to send contributions back    |
| `OPENLIBRARY_SECRET_KEY` | _(none)_ | Paired with the access key                          |
| `OPENLIBRARY_ALLOW_IMPORT` | _(unset)_ | `true` allows creating records for books Open Library lacks |
| `OPENLIBRARY_SOURCE_PREFIX` | _(none)_ | `source_records` prefix for imports, agreed with Open Library |

### ISBN lookup sources & the Google Books quota

Lookups merge **Open Library** (preferred) and **Google Books**. Open Library
doesn't have every book, and **keyless Google Books has a very small shared daily
quota** — when it's exhausted the API returns HTTP 429, and a book that's only on
Google Books will fail to auto-fill (the app now says it's rate-limited rather
than "not found"). A free Google Books API key raises the quota to ~1,000
lookups/day and makes this reliable.

#### Obtain a key (free, no billing required)

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and sign in.
2. Create a project (top bar → project dropdown → **New Project**), or reuse one.
3. Enable the API: **APIs & Services → Library → search "Books API" → Enable**
   (a.k.a. "Google Books API"). It has a free daily quota; no billing needed.
4. Create the key: **APIs & Services → Credentials → Create credentials → API key**.
   Copy the key. Recommended: **Edit API key → API restrictions → restrict to
   "Books API"** so the key can't be used for anything else.

#### Install the key

**Homelab node:** add it to `/etc/home-library.env`, which the systemd unit
passes to the container, then `ssh homelab 'sudo systemctl restart
home-library'`. Rotating a key is the same edit followed by the same restart.

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
the *work* as a tag written `[series:series_name]` on the edit form — the
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
   *through the website* needs no approval; any confirmed account can do it, and
   librarian status only adds merging and collections. **Editing through the API
   is gated separately.** Infogami's REST handler calls `can_write()` on every
   PUT, and Open Library overrides it to allow only accounts with the bot flag,
   site admins, and members of `/usergroup/api`
   ([code.py](https://github.com/internetarchive/openlibrary/blob/master/openlibrary/plugins/openlibrary/code.py),
   [infogami api](https://github.com/internetarchive/infogami/blob/master/infogami/plugins/api/code.py)).
   Without it every metadata edit here returns **403 Forbidden**, no matter how
   legitimate.

   So open an issue on the
   [openlibrary repo](https://github.com/internetarchive/openlibrary/issues)
   asking a site admin to grant bot privileges and add the account to the `API`
   usergroup. Say what the bot will edit and how often; ours fills empty
   `physical_dimensions`, `physical_format` and `number_of_pages` fields, adds a
   `series:` subject tag to works that have none, and uploads covers for
   editions that have none, all at human-review pace. Expect this
   to take a few days — it is a manual review by a volunteer.

   **Covers are the exception.** `/books/OL…M/add-cover` is an ordinary form
   endpoint with no `can_write()` check, so cover uploads should work as soon as
   the account can log in — before the usergroup request is granted.
3. **Get the keys.** Signed in as the bot, visit
   [archive.org/account/s3.php](https://archive.org/account/s3.php) and copy the
   access key and secret key. (Open Library authenticates with Internet Archive
   S3-style keys, then hands back a session cookie.)
4. **Install the keys** the same way as the Google Books key — in
   `/etc/home-library.env` on the homelab node, or the environment locally:

   ```bash
   OPENLIBRARY_ACCESS_KEY=your_access_key
   OPENLIBRARY_SECRET_KEY=your_secret_key
   ```

Until the keys are set, the queue still collects gaps; it just cannot send them,
and says so.

### Books Open Library has never heard of

Some books — recent small-press titles especially — have no Open Library edition
at all, so there is nothing to contribute to. Those can be *created* through
`/api/import`, but creating a record is a different act from filling a blank: a
bad edit is one wrong field, a bad import is a duplicate or a phantom book, and
duplicates can only be merged by librarians. So it is off by default:

```bash
OPENLIBRARY_ALLOW_IMPORT=true
OPENLIBRARY_SOURCE_PREFIX=yourbot   # the source_records prefix, agreed with Open Library
```

With both set, a scan proposes a new record for any ISBN Open Library does not
have, provided the book carries enough to identify it — Open Library accepts
either a complete record (title, authors, publishers, publish date) or a title
plus a strong identifier (ISBN/LCCN), and both need `source_records`.

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

**↑ Give back** → **Look for gaps** checks your books (most recently updated
first) against Open Library, one request per book, and queues what it finds.
Each row names the book, the edition it would edit, the field, and the exact
value that would be sent. **Send** submits it; **Skip** retires it.

Sending re-reads the live record first and refuses if the blank has been filled
in the meantime — a queue can sit for days, and someone else may have got there
first.

### On the homelab node

The app runs on the `homelab` node as a **Docker container managed by systemd**,
and is served at `http://homelab/library/` (also `http://10.0.0.2/library/`,
`http://100.84.6.113/library/`, and over HTTPS at
`https://homelab.dala-hue.ts.net/library/`).

- the unit is `/etc/systemd/system/home-library.service`, with `Restart=always`;
- the container runs with `BASE_PATH=/library` and `--rm`, so the unit owns its
  whole lifecycle — never start one by hand, the unit's `ExecStartPre` removes it;
- the SQLite DB lives on the node at `/var/lib/home-library`, bind-mounted to `/data`;
- secrets (`GOOGLE_BOOKS_API_KEY`, `OPENLIBRARY_ACCESS_KEY`,
  `OPENLIBRARY_SECRET_KEY`) come from `/etc/home-library.env` on the node;
- port 3000 is published on `127.0.0.1:30800`, fronted by the node's nginx, which
  proxies `location /library/` (see [`deploy/nginx-library.conf`](./deploy/nginx-library.conf)).

Deploy / update — build locally, hand the image to the node, restart the unit.
There is no image registry, so the image travels over ssh:

```bash
docker build -t library.local/home-library:1.0.0 .
docker save library.local/home-library:1.0.0 | ssh homelab 'sudo docker load'
ssh homelab 'sudo systemctl restart home-library'
```

Docker on the node needs `sudo`. To change a secret, edit
`/etc/home-library.env` and restart the unit.

## HTTPS (for camera scanning)

Browsers only allow camera access over **HTTPS** or on `localhost`, so barcode
scanning needs an HTTPS URL. This deployment uses a **Tailscale cert** via
`tailscale serve`, which terminates TLS and proxies to the node's nginx:

```bash
# One-time: enable "HTTPS Certificates" in the Tailscale admin console
# (https://login.tailscale.com/admin/dns), then on the homelab node:
sudo tailscale serve --bg --https=443 http://127.0.0.1:80
```

Tailscale obtains and auto-renews the Let's Encrypt cert; no cron needed. The
app is then available over HTTPS at:

**https://homelab.dala-hue.ts.net/library/**  (reachable from any device on the tailnet)

A Tailscale cert is only valid for the node's MagicDNS name, so the bare IPs
(`10.0.0.2`, `100.84.6.113`) and the short name `homelab` stay on plain **HTTP**
— fine for browsing on the LAN, but use the `ts.net` URL from your phone when you
want to scan. Because Tailscale proxies to nginx over http, the nginx `/library`
redirect uses `absolute_redirect off` so it preserves the client's scheme.

## API

All endpoints are under `/api`:

- `GET/POST /books`, `GET/PUT/DELETE /books/:id` — filters: `q`, `status`,
  `room`, `genre`, `format`, `shelf_id` (`none` = unshelved).
- `GET/POST /shelves`, `GET/PUT/DELETE /shelves/:id` — list includes computed
  capacity stats (`used_width_mm`, `free_width_mm`, `fill_pct`, `est_additional`,
  `overfull`, `too_tall`, `too_deep`, `unknown_thickness`).
- `GET /lookup/:isbn` — merged Open Library + Google Books metadata.
- `GET /meta` — distinct rooms, bookcases, genres for autocomplete + counts.

## Notes

- Deleting a shelf keeps its books; they become "Unshelved".
- ISBN dimension data is sparse in both APIs — when it's missing, measure the
  book and enter height/width/thickness by hand to enable shelf-fit calculations.
