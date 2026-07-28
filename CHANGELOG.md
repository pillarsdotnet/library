# Changelog

Notable changes to this project. The [README](./README.md) describes the app as
it stands now; this file is where the history lives.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
