# Changelog

Notable changes to this project. The [README](./README.md) describes the app as
it stands now; this file is where the history lives.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Slim or Alpine? in the README.** A measured comparison of the two images:
  size, memory and CPU, with slim under `MALLOC_ARENA_MAX=2` as a third column.
  Alpine is 18% smaller to download and holds 46% less memory after heavy
  imports, and spends 14–48% more CPU per request. The benchmarks that produced
  it are in `bench/`: `memory.mjs` for memory, and `cpu.sh` with `cpu-micro.mjs`,
  `cpu-http.mjs` and `cpu-report.mjs` for CPU.

### Changed

- **Deploys pull the published image instead of building one.**
  `deploy/deploy.sh` has the node pull `ghcr.io/pillarsdotnet/library:<version>`
  (`VARIANT=alpine` for the Alpine image) and refuses a version CI has not
  published, so only a merged, green build can be deployed. `TAG=` deploys an
  older version, which makes a rollback a pull rather than a checkout and
  rebuild. `BUILD=local` keeps the old build-and-ship-over-ssh path for when
  `ghcr.io` cannot be reached.

### Removed

- **The Alpine and `arm64` images.** CI builds, checks and publishes one image,
  Debian slim for `amd64`, with the plain tags. The `Dockerfile` has no
  `VARIANT` any more, and neither has `deploy/deploy.sh`. Images already
  published as `-alpine` or for `arm64` stay on `ghcr.io` but get no updates.
  The slim-or-Alpine comparison in the README is replaced by a pointer to the
  commit that has it; the `bench/` scripts stay, and compare any images.

### Fixed

- **A flaky browser test stopped CI publishing images.** The duplicate-scan
  test waited on a live lookup against Open Library, Google Books and Barnes &
  Noble, and timed out when they were slow; that failed the 5.4.0 merge, so
  nothing was published. The test now answers the lookup itself, like the
  re-scan test beside it.

## [5.4.0] — 2026-09-28

### Added

- **The server's owner is a member of every library.** User 1, the first
  account the database held, joins each library as it is created, and every
  existing one on upgrade. Anyone with a Google account can start a library,
  so the owner can now look into any of them. The Members screen marks the
  owner, and nobody can remove them.
- **The owner is emailed when a new library is created**, naming the library
  and who started it. The app sends through Gmail (`smtp.gmail.com:587`,
  STARTTLS required) with an app password in `SMTP_USER` / `SMTP_PASSWORD`;
  with those unset, nothing is sent. A failed send is logged and never holds
  up the sign-in that created the library.
- **Published Docker image.** Every merge to `main` that passes the Code
  Checker workflow now builds the image and pushes it to
  `ghcr.io/pillarsdotnet/library`, tagged `latest`, the `package.json`
  version, and `sha-<commit>`.
- **Four images per merge.** Debian slim and Alpine, each for `amd64` and
  `arm64`, built on native runners. Slim keeps the plain tags; Alpine takes
  the same tags ending `-alpine`. Pull requests build and check all four too.
- **Checks inside each image.** CI runs the due-date tests, a new timezone
  test and a new garbage-collection stress test inside every image before
  publishing it. The timezone test compares SQLite's `localtime` with Node's
  own timezone data; the stress test frees 300,000 prepared statements under
  allocation pressure.

### Changed

- **Node is no longer pinned to 24.18.1.** The pin guarded against
  [nodejs/node#65446](https://github.com/nodejs/node/issues/65446), which
  aborts an addon built on `node::ObjectWrap` when garbage collection frees one
  of its objects. `better-sqlite3` 11 was such an addon; 12 onwards uses
  `Napi::ObjectWrap` and is not affected. The new stress test aborts on
  `better-sqlite3` 11.10.0 with Node 24.21.0 and passes on 13, on both Debian
  and Alpine. The Docker image and CI now follow `node:24`.
- **Smaller Docker image: 654 MB to 287 MB.** `better-sqlite3` compiles from
  source on every install, so the image carried the compiler toolchain
  (`python3`, `make`, `g++`, about 280 MB) it needed only while building. A
  two-stage build now compiles in the first stage and copies just
  `node_modules` into a clean runtime image.

### Fixed

- **The Alpine image would have judged due dates in UTC.** `node:alpine` ships
  no zoneinfo, so its C library ignored `TZ` and so did SQLite, while Node's own
  timezone data made the startup log name the right zone. The Alpine image
  installs `tzdata`.
- A session from before libraries is now honoured for the **first** library,
  the only one there was when it was issued. It used to be honoured for a
  user's only library, which the owner, in every library, no longer has.
- The 5.2.0 entry says `better-sqlite3` 13 ships prebuilt binaries. It does
  not: its install script is `node-gyp rebuild`, which always compiles.

## [5.3.0] — 2026-09-28

### Changed

- **Add book starts on the filtered shelf.** With the Books tab filtered to a
  shelf, the Add book dialog now opens with that shelf already chosen, instead
  of Unshelved. With no shelf filter it still opens Unshelved.

## [5.2.0] — 2026-09-28

### Added

- **Copy a bookcase.** The bookcase dialog's Save button is now two: **Edit**,
  which moves or renames the bookcase as before, and **Copy**, which makes a
  new bookcase with the same shelves under the room and name given, leaving the
  books where they are. It refuses to copy onto a bookcase that already exists.
  Through a new `POST /api/bookcases`.

### Changed

- **No known vulnerabilities or deprecated packages.** `npm audit` reported 12
  (7 high, 5 moderate) and `npm ci` warned that `prebuild-install` is
  deprecated. `better-sqlite3` 13 ships its prebuilt binaries in the package and
  no longer needs `prebuild-install`; `sharp` 0.35.5 fixes its libvips and
  libheif advisories, and an override moves the scanner library's bundled
  `sharp` onto it; `npm audit fix` updated `qs` under `express` and the linters'
  dependencies. ESLint 9 turned out to be deprecated as well, which `npm ci`
  never said: it is now ESLint 10, whose `no-useless-assignment` rule removed
  four dead `= null` initialisers.
- **A new `npm run check:deps`** refuses any vulnerability or deprecated
  package. The `pre-commit` hook and CI both run it.

## [5.1.0] — 2026-09-28

### Added

- **Move or rename a bookcase.** A bookcase's name on the Shelves tab is now a
  link to a dialog that changes its room and name for all of its shelves at
  once, through a new `PUT /api/bookcases`. Before, moving a bookcase meant
  editing every shelf in it one by one.

## [5.0.2] — 2026-09-28

### Fixed

- **The phone header still wrapped on CI's wider fonts**, with 13px to spare
  where 24px is asked for. Every header button, not only ⚙, now has narrower
  side padding.
- **Node 24.18.1, pinned.** Every 24.x release from 24.19.0 on can abort
  `better-sqlite3` while freeing a statement during garbage collection
  ([nodejs/node#65446](https://github.com/nodejs/node/issues/65446)). It crashed
  a test file on CI's 24.21.0, and a floating `node:24-slim` would have shipped
  it. The Docker image and CI stay on 24.18.1 until that is fixed.

## [5.0.1] — 2026-09-28

### Fixed

- **"+ Add book" wrapped onto its own line on a phone.** The ⚙ Account button
  added in 5.0.0 left the header's button row 17px short of full at 412px,
  so wider fonts pushed the last button down. The icon button is narrower and
  the row's gaps tighter, and the header test now demands room to spare.

### Changed

- **Node.js 24.** The Docker image, CI and `engines` move from Node 20 and 22
  to 24, and CI's actions move to their Node 24 releases.

## [5.0.0] — 2026-09-27

### Added

- **Many libraries on one server.** A new `libraries` table, with `users` and
  `library_users` saying who may use which. Shelves, editions, copies, genres,
  series and Open Library proposals each carry a `library_id`, and every route
  reads and writes only the signed-in library's: another library's ids are not
  found, and its shelves, genres, series and books cannot be linked to.
  Uniqueness is per library, so two libraries may own the same ISBN. Triggers
  make the database itself refuse a row without a library, a row that moves
  library, and a link between two libraries' rows.
- **Signing in names a library.** `/auth/login` is now a form asking for the
  library name before handing over to Google. An unused name creates the
  library, with the person signing in as its only member and its own starter
  genres; a name in use admits its members and nobody else. The session
  carries the library, one at a time; a remembered sign-in (`hl_last`) fills
  the form in next time and offers Google the same account.
- **The header names the library**: "📚 Bobbalisa Library" instead of "Home
  Library", in the page and the tab title.
- **An Account screen (⚙)** to switch library, sign out, manage the library's
  members (any member may add or remove others; not themselves, not the last),
  and hold your own Open Library keys.

### Changed

- **Open Library keys belong to users.** Each user saves their own on the
  Account screen; they are verified by signing in to Open Library first and
  stored encrypted under a key derived from `SESSION_SECRET`. **Give back is
  shown only to a user with saved keys**, its endpoints refuse anyone else,
  and sends go out under that user's keys. With sign-in on,
  `OPENLIBRARY_ACCESS_KEY` and `OPENLIBRARY_SECRET_KEY` are no longer read;
  with sign-in off, nothing changes.
- **Authorization is rows, not a file.** On the first start the library
  "Bobbalisa" is created, everything already in the database becomes its, and
  the addresses in `allowed-emails.txt` become its members. The file is not
  read again. Sessions from before this carry across for anyone in exactly one
  library.

## [4.5.0] — 2026-09-27

### Added

- **The Give-back dialog says how much of the library has been checked.** A
  standing line gives the books checked against Open Library, how lately, how
  many never have been, and how many contributions have been sent. When every
  row left has been refused, a note says there is nothing new to send. A queue
  holding only the rows Open Library refuses (#13708) had read as a search that
  was not working, when every other gap had been found and sent.

### Fixed

- **A search's result no longer vanishes.** "Checked 25 books, found 0 gaps"
  was overwritten by the sent count the moment the list redrew, so a search
  that found nothing looked like a click that did nothing.

Four failover bugs, all found by the first handoff that actually moved the
database since the code that broke went in.

- **A standby that shut down pushed its stale database over the live one.** A
  standby's `home-library-db` unit is active too, so its shutdown ran
  `db-release`, and the generation guard let the push through because every
  handoff writes the same generation to both nodes. `db-release` now does nothing
  on a node that does not own the database.
- **Taking over left the app stopped on a node that had booted as standby.** Its
  database unit was already active, so starting it ran nothing and the activity
  flag was never written. The `takeover` verb now runs `db-claim` itself in that
  case.
- **`to-local` and `to-remote` failed on their first step**, because each step
  re-ran the script and found its own parent holding the lock. The steps now
  inherit it.
- **Cover images failed to transfer in a handoff:** GNU `tar` has no
  `--no-absolute-names`. Its defaults already strip leading `/` and refuse `..`.

## [4.4.1] — 2026-09-25

### Fixed

- **The app can be added to a home screen again with sign-in on.** The
  manifest was behind the sign-in gate, and a browser never sends the session
  cookie when it fetches one, so every request for it got `401`, even from a
  signed-in phone. The manifest and the icons it lists are now served in front
  of the gate, like `/healthz`. The list comes from the manifest itself, so an
  icon added later is covered too. The rest of `public/` still needs sign-in.

## [4.4.0] — 2026-09-22

### Added

- **A dropped request is retried instead of counted as a rejection.** Six field
  sends failed in one session with a bare `fetch failed` — a network error that
  never reached Open Library, which nonetheless dropped each row into `failed`
  looking just like a refusal. A send now retries a *thrown* fetch a few times
  with a short backoff, while a *returned* response — even a `403` — is still
  taken as Open Library's answer and never retried. `login` retries the same
  way. Retrying a write is made safe by re-reading the record before every
  attempt: if a previous PUT actually landed and only its reply was lost, the
  field now reads as filled and the send stops rather than writing twice. When
  every attempt is exhausted the raw network error is thrown, carrying no HTTP
  status, so it is still logged as a network failure rather than a rejection.

## [4.3.0] — 2026-09-22

### Added

- **Every refused send is now logged with what the other end actually said.**
  A contribution row keeps only its most recent error, so a `403` that resolves
  on a retry and one that never will read identically in the queue — the
  difference was only ever in the reply body, which was thrown away.
  `ol_send_attempts` keeps the status, the first 500 characters of the response
  and the message the reviewer saw, and `GET /api/ol-contributions/attempts`
  groups them by status and by field.

### Fixed

- **A refusal from Open Library's front door no longer reads as the catalogue
  disagreeing with us.** Some requests are answered by the nginx in front of
  Open Library and never reach it at all; the message now says so. One cause is
  identified by name: a `PUT` whose body contains a quote followed by `--` is
  refused with a bare `403`. That is the SQL comment injection signature, and a
  MARC-derived description routinely ends `"--` before its source attribution —
  so a record carrying one cannot have *any* blank field filled through the API,
  by us or by anyone, because the whole record goes back on every `PUT`.

## [4.2.1] — 2026-09-22

### Fixed

- **A proposal that failed was invisible.** The approve handler keeps a failure
  "so it can be retried or declined", but the queue only ever asked Open Library
  for `pending` rows, so a failed one could never be seen or acted on. Nine rows
  were stranded on the live database — six of them covers from before Open
  Library stopped taking them from a program. The queue now lists everything
  still waiting for a person, `pending` and `failed` alike, with the reason it
  failed; `?status=` still narrows it.
- **Repeated sweeps re-read the same books.** "Look for gaps" ordered editions
  by `updated_at`, so once the most recently touched 25 were done, every further
  click re-examined those same 25 and reported nothing — while 626 of 680
  editions had never been looked at once. Editions now record when they were
  last compared against Open Library (`editions.ol_checked_at`) and the sweep
  takes the least recently checked first, so clicking it repeatedly walks the
  whole library.

## [4.2.0] — 2026-09-22

### Added

- **3 · Done — check**, on a cover row. A cover leaves this app through Open
  Library's own form, in your browser, so nothing here can know the upload
  happened. The only other way to clear the row was **Skip**, which records a
  decision never to offer that book again — the opposite of what actually
  happened. This asks Open Library instead: one request, running the same review
  a sweep does, so "this row is done" and "everything is up to date" can never
  disagree about what a gap is. A row whose cover really arrived closes as
  `satisfied` and the adoption proposal appears in its place; an upload that
  silently failed leaves the row exactly where it was and says so, which is the
  point of checking rather than dismissing.

### Changed

- The per-book half of a scan is now one function, shared by the sweep and by
  the single-row re-check, rather than a loop body only the sweep could reach.

## [4.1.1] — 2026-09-22

### Changed

- **The cover row numbers its two steps.** Saving the image is not optional
  before opening Open Library's form, and skipping it is a dead end rather than
  an error: the form opens a file picker, and a picker cannot offer a file that
  was never saved. The buttons now read **1 · ↓ Save image** and **2 · Upload it
  there ↗**, with a line saying that the picker opens *Photos* on a phone while
  the saved image is under *Files → Downloads*.

## [4.1.0] — 2026-09-22

### Added

- **Cover rows hand the upload back to you.** Open Library takes covers only
  through its own form, which refuses a program but works perfectly for a
  signed-in person — so the cover row now offers the two things needed to do it
  by hand, the image and the right `add-cover` page, instead of a Send button
  that can only fail.
- **Open Library's cover can be adopted in place of a photograph.** When a scan
  finds that Open Library has acquired a cover for an edition you photographed,
  it queues a proposal showing both images side by side. Approving it deletes
  the copy's photograph and its uncropped source and falls the edition back to
  Open Library's artwork, which is what `editions.cover_url` has always been
  for. It is the only approval that deletes anything and the only one that needs
  no Open Library account, so it asks for confirmation naming what goes.
- **⟳ Check my photos**, a scan scoped to the editions carrying a photograph.
  The default sweep is ordered by what changed recently and never reaches a book
  catalogued a year ago — which is why 13 of 19 photographed books had never
  been looked at.

### Fixed

- **A proposal somebody else has since satisfied now closes itself.** The queue
  was `INSERT OR IGNORE` and nothing ever closed a row, so three cover rows sat
  as `failed` for books Open Library had since acquired covers for. A field that
  is no longer a gap is marked `satisfied`, which also stops it being
  re-proposed; a scan reports how many it closed. This retires an `import`
  proposal too, once Open Library has the book.

## [4.0.6] — 2026-09-22

### Fixed

- **"Open Library rejected the cover (405)" now says what actually happened.**
  Covers are the one contribution that goes through a browser *form* rather than
  the JSON API, and Open Library has put those behind a human-verification
  challenge that a bot account cannot pass. Measured against the live site: an
  authenticated `PUT` of a record reaches the handler, an authenticated
  multipart `POST` to `add-cover` gets `405` from their front end — before
  routing, since a nonexistent OLID gets it too — and an anonymous one is sent
  to `/verify_human`. Nothing here is retryable and nothing is misconfigured, so
  the message says so instead of echoing a status code that reads like a bug in
  this app. **Every other contribution is unaffected.**
- A cover POST that is redirected to the verification or login page is no longer
  counted as a success. Any `302`/`303` used to mean "sent", which would have
  marked a contribution delivered that Open Library never took.

## [4.0.5] — 2026-09-22

### Changed

- **A sign-in now slides instead of expiring on a fixed date.** It was an
  absolute 30 days from signing in, so somebody who used the library daily was
  still bounced to Google on the thirtieth day. It is now ten days of *not*
  visiting, and any visit pushes that back out — so a regular visitor never
  signs in again, and an account that goes quiet is signed out ten days later.
  The cookie is re-issued only once a session is past its half-life, so browsing
  does not put a `Set-Cookie` on every asset.
- `SESSION_TTL_DAYS` is now `SESSION_IDLE_DAYS`, because it no longer means a
  lifetime. The old name is not read; the startup banner says so if it is set,
  rather than silently ignoring it.

### Fixed

- **A non-numeric session timeout minted sessions that never expired.**
  `SESSION_TTL_DAYS=10d` parsed to `NaN`, and `NaN < Date.now()` is false, so
  every expiry check accepted such a session for ever — a typo that failed
  silently and in the direction of less security. Anything that is not a finite
  number now falls back to the default, floored at one day.

## [4.0.4] — 2026-09-22

### Fixed

- **Sign-in took the site down on the first deploy that used it.** The failover
  script claims the floating IP only once the app answers `200`, and it asked
  for `/library/` — which sign-in turns into a `401`. A perfectly healthy node
  looked dead, so the VIP was never assigned and `vip_down_local` had already
  withdrawn its tailnet route, which is what reaches phones off the LAN. nginx
  stayed bound to the VIP through `ip_nonlocal_bind`, so connections hung rather
  than being refused, and the address did not even ping.

  There is now a `/healthz` route, mounted in front of the gate, and
  `deploy.sh`, `failover.sh` and `failover-peer.sh` all ask for it. A probe
  carries no identity and cannot be sent through an OAuth redirect, so refusing
  it says nothing about the app. It reads from the database rather than merely
  answering, because an app that cannot read the library is not one to hand the
  VIP to.

## [4.0.3] — 2026-09-22

### Added

- **Sign in with Google.** Setting `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
  puts every page and every API route behind a Google account; leaving them
  unset leaves the app open exactly as before, and the startup banner says which
  of the two it is doing. Sessions are signed cookies (`SESSION_SECRET`,
  `SESSION_TTL_DAYS`), the flow uses PKCE and a state cookie, and the OAuth
  exchange is written out rather than pulled from a dependency.
- **An allowlist file.** `allowed-emails.txt` beside the database names the
  addresses permitted to sign in — one per line, `#` for comments. Absent or
  empty means every signed-in address is allowed. It is read on every request,
  so removing a line ends that session on the next click without a restart.

### Changed

- The `source_records` stamp on an import is now always the canonical 13-digit
  ISBN. A book catalogued by its 10-digit ISBN and the same book catalogued by
  its 13-digit one used to leave two different marks in Open Library, so our own
  imports read back as two unrelated sources. Surveyed against 5,386 Open
  Library editions: every `bwb` stamp is an ISBN-13 and every `idb` stamp is
  too, which is the convention this now follows.
- A book whose ISBN fails its check digit is no longer offered for import at
  all. It was previously sent as `isbn_13`, which would have published an
  unverifiable identifier in a public catalogue; filling blanks on an existing
  record is unaffected.
- The `source_records` prefix now has a default, `pillarsdotnet_library`, rather
  than being unset until an environment variable supplied one.
  `OPENLIBRARY_SOURCE_PREFIX` still overrides it, and setting that variable to
  an empty string is a deliberate "no prefix", which as before means no import.
  A prefix carrying a colon, whitespace or a slash is refused rather than
  stamped wrong, since every reader of the field takes the prefix to be
  everything before the first colon.

## [4.0.2] — 2026-08-01

### Changed

- The header takes two lines on a phone instead of three. The book count moved
  up beside the version, on the title line, and **+ Add book** joined **mm** and
  **↑ Give back** on the row below. It also stopped being a `primary` button:
  accent on an accent-coloured header paints no chip at all, so it read as a
  stray line of text rather than something to tap.
- The header no longer reports how many books are unshelved. It was a running
  count of a condition nobody was acting on, sat in the one place every screen
  shows; the shelf filter answers the question on demand.

## [4.0.1] — 2026-08-01

### Fixed

- The cover migration's `VACUUM` reclaimed nothing visible while the app was
  running. In WAL mode the rewrite lands in the write-ahead log, so the database
  file is not truncated until something checkpoints it — which, for a
  long-running server, is whenever the process next happens to exit. On the live
  node that left a 15 MB file whose contents were 450 KB, plus a 7.9 MB WAL. The
  migration now checkpoints immediately after the `VACUUM`.

  Locally this was invisible: a migration script exits, and closing the last
  connection checkpoints on the way out.

## [4.0.0] — 2026-07-31

### Changed

- **Cover images are files, not database rows.** They were stored as base64
  data-URLs and were roughly half the database — so every backup, every failover
  handoff and every hourly sync carried about 7 MB of image data that SQLite is
  not the right place for. They now live in a `covers/` directory beside the
  database; the row keeps a filename and a hash of the bytes.

  On the live library the database went from **15.4 MB to 459 KB** — base64
  inflates by a third, and `VACUUM` also reclaimed pages the 3.0.0 migration had
  left dead. The images are 5.3 MB on disk. Serving is now `sendFile` rather than
  decoding base64 on every request, and the EPUB import writes the resized JPEG
  straight to disk instead of base64-encoding it into a column.

  **Major, because the data is no longer in one file.** A backup of `library.db`
  alone is no longer a backup: every row naming a missing image is a broken
  picture. Copy the covers directory with it. The failover handoff and the hourly
  sync were both taught to move both — `covers-send`/`covers-recv` verbs for the
  handoff, and an rsync of the directory for the hourly copy, which is where
  rsync earns its keep since almost nothing changes between runs.

  The API is unchanged: covers were already returned as `api/books/:id/cover`
  references rather than bytes.

- `eslint.config.js` matches server-side modules by glob rather than by a list of
  filenames. `covers.js` was linted without Node globals purely because nobody
  remembered to add it, and only a stray `process` reference made that visible.

## [3.2.0] — 2026-07-31

### Changed

- **Listings no longer read cover images they were only going to throw away.**
  Covers are stored inline as base64 data-URLs — about 47% of the database — and
  every list request pulled 608 KB of them out of SQLite so that `coverRef` could
  replace each one with a URL. None of those bytes ever reached a client.

  The cache-busting token is now stored beside the image (`copies.cover_token`,
  `copies.cover_source_token`) instead of being hashed from it on every read, so
  listings can select the token and leave the base64 on disk. It cannot be derived
  in SQL instead: `length()` walks the whole overflow chain to count characters
  and measured exactly as expensive as fetching the bytes.

  Measured on 663 real books: **252 → 960 req/s** on the default list page, p50 at
  25 concurrent clients **92 ms → 26 ms**, and the whole-library response
  (`limit=0`) blocks other requests for 7 ms instead of 27 ms.

- **Genre and series decoration is scoped to the page.** `attachGenres` ran two
  queries with no `WHERE` clause, reading every row of `book_genres` and
  `series_books` to decorate twenty books — a cost that grew with the size of the
  library rather than the size of the page, so it got quietly worse forever.

- The EPUB import returns its cover as a reference like every other book
  response, rather than echoing back half a megabyte of base64 the client had
  just uploaded. `cover_source` is now `null` rather than `''` when a copy has no
  kept-back original; both are falsy, and nothing read it any other way.

## [3.1.0] — 2026-07-31

### Added

- The running version is shown beside the title, in the header and the browser
  tab. Assets are cache-busted by version, so "which build is this device
  actually showing?" was previously unanswerable from the device itself — which
  is the question that matters when a deployed fix appears not to have worked.

- **Hourly one-way copy of the database to the failover node**
  (`deploy/db-sync.sh`, `/etc/cron.d/home-library-db-sync`). Installed on both
  nodes and inert on whichever one is not active, so the job follows the database
  through a handoff instead of naming a fixed master.

  It skips before doing any work when nothing has been written since the last run
  — fingerprinting the database *and* its WAL, since in WAL mode the main file's
  contents can sit unchanged through a busy hour. A peer that is simply offline
  logs to the journal and exits 0, because an hourly cron mail about a known-down
  standby is how people learn to ignore cron mail; anything else fails loudly.

  The copy lands in `<data dir>/standby/library.db` on the peer and never on the
  peer's own `library.db`: overwriting that would bypass `assert_generation_ok()`,
  which exists to refuse replacing a copy a later handoff produced. It is a
  disaster copy, restored deliberately, not a replication channel. Transport is a
  dedicated key pinned to `rrsync -wo`, which can only write and only into that
  directory — the failover key is pinned to the verb script and deliberately has
  no path to rsync.

### Fixed

- **The failover snapshots were not backups.** `snapshot_local()` and the peer's
  `db-snapshot` verb both took a timestamped **hardlink** — another name for the
  same inode. SQLite writes in place, so all ten "generations" tracked the live
  database and the rotation preserved nothing; it looked exactly like a working
  set of restore points. They are now `.backup` copies, which are consistent even
  against a database something still has open (`cp` would not be). Ten
  generations of a 12 MB database now costs 120 MB of disk, which is the price of
  those files meaning anything at all.

## [3.0.0] — 2026-07-31

### Changed

- **Book data is split along the ISBN.** The flat `books` table becomes two:
  `editions` holds everything an ISBN determines and every copy therefore shares
  (title, authors, publisher, page count, and the physical facts of the edition);
  `copies` holds what is true of one object on one shelf (dust jacket, shelf,
  status, loan, library borrowing, notes, and a photograph of that copy).

  Catalogue a book you already own and the second copy arrives fully described,
  because the metadata was never the copy's to begin with. Correct a publisher
  once and every copy is corrected. This is also the groundwork for hosting more
  than one library: editions are shared, copies are not.

  `books` remains as a **read-only view** joining the two, so every existing
  query and API response is unchanged — including `library_name`, now an alias
  of `copies.borrowed_from`. Writes name `editions` and `copies` directly:
  SQLite reports `lastInsertRowid` 0 and `changes` 0 for writes through a view,
  which would look like success while doing nothing.

  **Major, because the migration is one-way**: a database written by this build
  cannot be read by 2.x, which expects `books` to be a table.

- **An edition is identified by ISBN *and* format**, not by ISBN alone. In
  principle one ISBN means one format, since a hardback and a paperback are
  separately numbered — but e-books have ASINs rather than ISBNs, and importers
  staple the print ISBN onto the e-book record. Matching on the ISBN alone fused
  Kindle files to hardbacks: the merged record kept one format and the other's
  physical dimensions, so a hardback on a shelf reported itself as an e-book.
  Changing a copy's format now moves it to its own edition rather than rebinding
  every copy that shares the ISBN.

- **ISBNs are canonicalised to ISBN-13 before they are stored.** `0441013597`
  and `9780441013593` are the same book; stored verbatim they produced two
  records that never merged. Check digits are verified rather than trusted — an
  ISBN that fails its check digit is kept for display but never used to match,
  because merging on a value we cannot verify would fuse two unrelated books and
  overwrite one's metadata with the other's. The lookup cache is re-keyed the
  same way, so a book cached from one spelling is found from the other.

- Genres, series membership and Open Library proposals now key on the **edition**
  rather than on a copy. Two copies of one book are tagged once, appear in a
  series once, and queue any given Open Library edit once. Open Library
  contribution rows expose `edition_id` where they previously exposed `book_id`.

- A second copy of a known ISBN now shows that book's title. It is edition data,
  so a title typed into the add form before the duplicate was detected is not
  kept — two copies of one ISBN cannot disagree about what the book is called.

## [2.3.2] — 2026-07-28

### Changed

- Due dates are now judged against the **local civil date** on both sides — the
  server's overdue filter uses `date('now','localtime')` and the card compares against
  the browser's local date. "Overdue" is a question about the calendar on the wall, so
  a book due today should not turn red at 8pm merely because UTC has rolled over.

  This only means anything if the container is told its timezone: SQLite reads the
  process timezone, so without `TZ` the container runs on UTC and `localtime` is a
  no-op. `TZ` therefore belongs in the env file passed to the container — setting it
  via systemd `Environment=` looks right and does nothing, because that reaches the
  `docker run` client rather than the container. In a failover pair it must be set
  **identically on both nodes**: inheriting the host would make a book overdue on one
  node and not the other, depending on which is active.

  The server now logs its timezone at startup, so a container silently running on UTC
  is visible rather than quietly shifting what counts as overdue.

## [2.3.1] — 2026-07-27

### Changed

- An overdue library book now looks overdue: the due line turns red, bold, and reads
  "Overdue since" rather than "Due". Previously **every** due date was coloured like a
  warning, so a book three weeks late looked identical to one due next month — there
  was nothing louder left to say for the case that actually matters. Future dates are
  now muted and only overdue is coloured, so the signal carries meaning. The state is
  stated in words as well as colour, since colour alone reaches neither a screen reader
  nor anyone who cannot distinguish it, and a separate dark-mode colour is used because
  the light-mode red is unreadable on a dark surface.

  "Overdue" is judged against a UTC date to match the server's `date('now')` in the
  overdue filter; using the local date would let the badge and the "Overdue only"
  filter disagree for a few hours each night. A book due *today* is not overdue.

## [2.3.0] — 2026-07-27

### Added

- Library books can be listed **by due date**, soonest first, with an
  **overdue-only** option. Borrowed books with no due date sort last rather than
  first: SQLite orders NULL ahead of any value, so the obvious `ORDER BY due_date`
  buries the genuinely urgent books beneath ones with no deadline at all. Being
  flagged as borrowed is what qualifies a book, not merely having a date, so a stray
  date on a book you own does not appear as something the library is waiting for.
  The filter composes with search and the other filters, and the total count honours
  it so paging stays correct.

### Changed

- `deploy/deploy.sh` detects a failover standby and ships the image without
  restarting it. The standby's app is deliberately not running, so a restart there
  would do nothing and the health check would report a failure that is in fact
  correct behaviour. Detected rather than flagged, so the script is safe to run
  against either node without knowing which is live; a deployment with no failover
  units behaves exactly as before.

- Active/passive failover between two nodes (`deploy/failover.sh` plus the
  `home-library-db` and `home-library-vip` units). The database follows whichever
  node is active, and a floating address follows it, so exactly one node is ever
  writable. Two interlocks guard the handoff: an owner marker carrying a
  **generation counter**, which decides authoritatively which copy is newer, and a
  refusal to overwrite a copy produced by a later handoff. mtimes are logged as a
  diagnostic but deliberately do **not** gate anything — merely opening a SQLite
  database updates its mtime, so a standby started for any reason would otherwise
  look newer than the rightful owner and block the next legitimate handoff.

  If the peer cannot be reached, the node never guesses: it keeps its own copy only
  when its own marker already names it as owner, and does so *without* advancing the
  generation, since raising it above a copy that was never compared would defeat the
  guard. If the marker names the unreachable peer as owner, it refuses to start
  rather than serve a stale copy as authoritative.

  Both nodes run identical units, so whichever is active hands over when it shuts
  down. `PREFERRED` decides which node reclaims on boot, since otherwise a standby
  reboot would take the service from a healthy active node; the other node comes up
  active only if it already owns the database. A standby boot skips the app and
  address units via `ConditionPathExists` on an activity flag, so it leaves nothing
  in a failed state.

  A handoff starts the receiving node's own units rather than starting its app and
  assigning its address by remote verb. The latter left the receiver's units inactive
  while it was in fact serving, so systemd disagreed with reality and — the part that
  actually bit — the receiver's next shutdown ran no ExecStop and handed nothing back.

### Changed

- The README now describes deploying generically — by the node's role rather than
  by name — instead of documenting one specific host and its addresses.

- `deploy/deploy.sh` now is the deploy: it builds, ships the image to the node,
  restarts the unit, and prunes every old home-library image afterwards, leaving
  only what is running. Rollback is `git checkout v<x.y.z> && deploy/deploy.sh` —
  each release is a git tag.
- A deploy no longer reports success until the app answers. Because the unit has
  `Restart=always`, `systemctl restart` exits 0 even while the container is dying
  and respawning in a loop, so a deploy could report success over a total outage.
  The script now polls the app on the node for HTTP 200 (`HEALTH_TIMEOUT`, default
  60s) and confirms the running container is the image just built; on failure it
  dumps `systemctl status` and the container log, skips the prune so the previous
  images remain for rollback, and exits non-zero.

## [2.2.0] — 2026-07-21

### Added

- ISBN lookups are cached, so a re-scan, a retry, or a second look at the same
  book does not spend another query against a rate-limited source. Every answer
  — found or not — is kept at least 24 hours; found ones for 30 days, since
  metadata barely changes. `?refresh=1` on the lookup endpoint re-fetches on
  demand.

### Changed

- Metadata sources are now consulted in order and only as needed, rather than
  Open Library and Google Books always in parallel: Open Library first, then
  Google Books only if a field it could supply is still blank, then Barnes &
  Noble on the same condition. A book Open Library describes completely costs
  one request, not three — and Barnes & Noble, a heavy scrape, now fills any
  blank field it can rather than the binding alone.
- When a source is rate-limited, a lookup falls back to whatever was last cached
  for that ISBN, however old, in preference to failing — stale data beats no
  data. Only an ISBN never looked up before returns an error.
- Metadata source hosts are overridable (`OPENLIBRARY_BASE`, `GOOGLE_BOOKS_BASE`,
  `BARNESNOBLE_BASE`), so a mirror or a test stub can stand in. They default to
  the real services.

## [2.1.0] — 2026-07-21

### Added

- When a scanned ISBN finds no metadata, the app offers a re-scan rather than a
  dead end. A 1D barcode can misread into a *different* number whose check digit
  still passes — 9781451787856 for 9781451638356 (War Maid's Choice) is a real
  one — so validation cannot catch it and "not found" is where it surfaces. A
  rate-limited source (503) is an outage, not a misread, and does not prompt.

## [2.0.0] — 2026-07-21

The version was still 1.0.0 after a year of features and one migration that
does not go backwards, so this catches up. Major, not minor: a database opened
by this release has had its legacy free-text `genre`/`subgenre` columns dropped
and its `series_books` primary key rebuilt, and an older build will not read it
back.

### Added

- Stylesheets and scripts are requested with `?v=<app version>`, so a release
  is a new URL and a browser cannot go on running a cached copy of last week's
  CSS. A `pre-commit` check refuses an asset change that does not move the
  version, since a fix that reaches the server but not the phone looks exactly
  like a fix that did not work.

- Contribute missing metadata back to Open Library, through a review queue.
  Nothing is sent without approval, and only fields Open Library leaves empty
  are ever offered — covers, physical dimensions, binding, page count, and the
  series tag on the work. See "Contributing back to Open Library" in the README
  for the account setup and for why series position is not contributed.
- ISBN lookup now reads the series and, where the source numbers it, the
  position — from the edition's `series` field, falling back to the work's
  `series:` subject tag. We contribute series information back, so it would be
  odd not to accept it.
- Create records for books Open Library has no edition of, via `/api/import` —
  off unless `OPENLIBRARY_ALLOW_IMPORT` is set, proposed through the same review
  queue, and rehearsed with `?preview=true` so a book that turns out to exist is
  matched rather than duplicated.
- `CHANGELOG.md` (this file).

### Removed

- The `k8s/` manifests, left over from an earlier Kubernetes deployment that no
  longer exists. They pinned a node by hostname and named an image tag nothing
  builds any more, so they were a wrong answer waiting to be followed. Deploy is
  Docker under systemd — see the README. `git log` has them if they are ever
  wanted back.

### Changed

- Nothing in the shipped app names one particular deployment any more. The
  "camera needs HTTPS" advice pointed at one homelab's Tailscale URL, which is
  no use to anyone running this elsewhere; it now names the host actually in
  use, with a test to keep it that way.
- README states plainly that there is no authentication of any kind, and what
  that means before exposing the app anywhere.

### Fixed

- On a phone, dialogs sat partly off-screen and had to be scrolled to. A filter
  select will not shrink below its widest option, so one long shelf name made
  the document scroll sideways — and a sideways-scrolling document drags every
  `<dialog>` off-centre with it. The toolbar selects, the dialog action rows and
  the header all hold their width now, down to 320px.
- The corner editor's bottom two handles were out of reach on a portrait photo:
  the canvas was sized on width alone, so it grew taller than the box that clips
  it. It now fits in both directions.
- The cover-adjust dialog opened onto a solid black rectangle: the corner
  editor's overlay set `display`, which outranks the browser's own `[hidden]`
  rule, so it covered the cropper while still marked hidden. `hidden` is now
  honoured globally, which also un-broke the library fields and the loaned-to
  and parent-genre labels.

## Earlier

Before this file existed, the git log was the changelog. `git log --oneline`
covers everything up to and including "Drag the corners yourself, now or later".
