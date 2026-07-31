# Changelog

Notable changes to this project. The [README](./README.md) describes the app as
it stands now; this file is where the history lives.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
