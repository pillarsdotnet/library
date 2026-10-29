# Changelog

Notable changes to this project. The [README](./README.md) describes the app as
it stands now; this file is where the history lives.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [5.23.0] — 2026-10-29

### Added

- **A blank Books tab shows a random sampling.** With the search box and every
  filter cleared, the listing comes back in a seeded shuffle instead of filed
  alphabetically — a cross-section of the library rather than the same first
  authors every time, re-dealt on each page load. The client draws one seed
  per visit and sends it as `seed` on `GET /api/books`; one seed names one
  complete ordering, so **Load more** pages onward through the same shuffle
  with nothing repeated or skipped, and saving a book does not reshuffle the
  screen. Any filter or search drops the seed and the filed order returns.
- **The server guarantees the sampling.** An unfiltered `GET /api/books` whose
  `seed` is missing or junk is redirected (302) to the same URL carrying a
  freshly minted seed, so the address always names the deal it shows; the
  client adopts a seed minted this way. `seed=0` is the one explicit refusal —
  the filed catalogue, no sampling — used by the bookcase visual, which needs
  spines in shelving order. A filtered listing ignores seeds entirely and is
  never redirected: a filter asks a real question, and the filed order
  answers it.

## [5.22.1] — 2026-10-25

### Changed

- **An LCCN no longer needs its hyphen.** The year is always the first two
  digits — or four, beginning `20` — so `6812345` reads as `68-12345` and
  pads itself; a phone's numeric keypad has no hyphen to give. The one shape
  that still needs one is a 2001-or-later number whose serial is not padded:
  bare `20081234` reads literally as the 1920 number, `2008-1234` as 2008's.

## [5.22.0] — 2026-10-25

### Added

- **A Library of Congress Control Number works in the lookup field**, for
  books older than the ISBN. An LCCN has no check digit, so anything that
  validates as an ISBN is still treated as one; the rest is tried as an
  LCCN, hyphenated (`68-12345`) or normalized (`68012345`), against the
  Library of Congress first — it assigned the number — then Open Library
  and Google Books. `ISBNdb` and Barnes & Noble answer only to an ISBN and
  are skipped.

## [5.21.1] — 2026-10-25

### Fixed

- **The hourly disaster copy works again under `rsync` 3.5.0.** That release's
  `rrsync` confines the receiving side with `--confine-root` and hands the
  destination over as an open directory descriptor, which made the database
  transfer fail on a file-name destination — every run since the upgrade
  ended in "could not make way for new regular file". The sync now names
  the directory and lets the snapshot's own filename land it.
- **A takeover no longer aborts when `Tailscale` is absent.** Advertising the
  floating address is skipped with a logged warning on a node where
  `tailscaled` is not running, instead of failing the handoff at its last
  step.

## [5.21.0] — 2026-10-25

### Added

- **A `stapled` format** for comic books and cheap magazines. It appears in
  the format filter and the edit form, lookups map saddle-stitched bindings
  ("Staple Bound", "Comic", "Pamphlet", "Magazine") onto it, listings file it
  after `paperback`, and the visual shelf draws an unmeasured stapled spine
  from the averages of the library's other stapled things — tall, wide and
  nearly flat — rather than presuming a paperback's thickness.

## [5.20.0] — 2026-10-25

### Changed

- **Cover files are named by the hash of their content.** The same photo
  stored for two copies — an `ebook` reusing the printed edition's cover, two
  copies of one book — now lands in a single shared file automatically. A
  shared file is removed only when the last copy referencing it is deleted or
  pointed at a new image. Files written under the old per-copy names keep working; they
  take the new name the next time their image is saved.

## [5.19.0] — 2026-10-25

### Changed

- **The Users tab now spans every library you manage.** It lists each library
  you founded — whichever one you are signed in to — and, for the server's
  owner (user 1), every library the server hosts, each with its own member
  list, add form, inline edit and remove. The founder and owner are marked in
  each list. Managing another library's users goes through new
  `/api/managed/libraries` routes; a library that is not yours answers 404,
  the same as one that does not exist.

## [5.18.0] — 2026-10-25

### Changed

- **Listings are filed the way a librarian shelves.** Books on a shelf, in a
  search, or anywhere no more specific order applies now sort by the primary
  author's surname, then given and middle names (with any generational suffix
  and the co-authors as tie-breakers), then series title (a standalone book
  files under its own title, so it interleaves with its author's series), then
  position in the series, then title with the leading article skipped, then
  binding — `ebook`, then hardback, then paperback. Surname particles (Le
  Guin, van Gogh)
  and generational suffixes file correctly. Filtering to one series still
  reads in series order, and the borrowed-books filter still sorts by due
  date.

## [5.17.0] — 2026-10-24

### Changed

- **The Lookup keys form moved from the Users tab to the Account dialog.** It
  is still the founder's alone — everyone else sees no such section — and the
  Users tab is back to being only about who may sign in.

## [5.16.0] — 2026-10-24

### Removed

- **All version-migration code.** The one deployment there is runs the current
  schema, so the one-way 2.x "books table" split, the base64-cover extraction,
  the column backfill steps and the per-user status seeding are gone; `db.js`
  only creates the current schema and maintains it. A database older than the
  current shape is no longer upgraded in place.
- The README sections describing earlier versions, including "Upgrading from
  2.x".

### Changed

- **The documentation is split three ways.** The README describes what the app
  does; [INSTALLING.md](INSTALLING.md) covers installing and operating it (the
  Debian package, Docker, plain Node, the environment, two-node failover,
  HTTPS and the API); [CONTRIBUTING.md](CONTRIBUTING.md) covers the data
  model, the pre-commit hooks, the versioning and dependency rules, and
  contributing metadata back to Open Library.

## [5.15.0] — 2026-10-24

### Added

- **`ISBNdb` joins the lookup chain** for a library whose founder stores a
  key: in a measured sample it was the fastest fallback and the only source
  that knew every book asked about, dimensions and binding included.
- **Lookup API keys belong to the library.** The Google Books and `ISBNdb`
  keys are stored per library, sealed at rest, and managed through a Lookup
  keys form on the Users tab that only the library's founder can reach; even
  the founder sees only a hint of a stored key, never the key back. The
  environment variables remain as server-wide defaults for libraries that
  store none.

### Changed

- **The lookup fallbacks now run fastest first, by measurement** (see
  `bench/lookup-sources.mjs`): Open Library always leads — it is the source
  this app gives back to — then `ISBNdb`, Google Books, the Library of
  Congress, and the Barnes & Noble scrape last.

## [5.14.0] — 2026-10-24

### Added

- **The Library of Congress joins the ISBN lookup chain**, third of four:
  consulted through its free, keyless SRU gateway when Open Library and Google
  Books leave a field blank that the catalog could fill (title, author,
  publisher, date, page count, spine height), ahead of the Barnes & Noble
  scrape. Its reach includes plenty of books the commercial sources miss. The
  gateway host can be overridden with `LOC_BASE`.

## [5.13.0] — 2026-10-24

### Changed

- **A stranger on a wish-list page now sees the 🎁 Purchase button too.**
  Clicking it leads through sign-in — library name and Google account — and
  back to the list with that book's date form already open, so the purchase
  completes only once they are somebody. Refusing or failing the sign-in
  returns to the list with nothing recorded (a refused Google sign-in now goes
  back to where the person was headed instead of an error page).
- **The spread-to-series genre prompt now asks whenever a saved book's genres
  differ from the rest of its series** — any of its genres missing from any
  other member — not only about genres added in that edit. Still add-only,
  still asked first, and still silent when the series already agrees.

## [5.12.0] — 2026-10-24

### Added

- **Genres follow a series, by invitation.** A book joining a series now
  offers to take on the genres the series' other books carry — the chips land
  in the dialog before saving, where they can still be pruned — and genres
  added by hand to a series member offer, on save, to spread to the rest of
  the series. Both directions ask first, both only add (nothing a book already
  carries is removed), and a genre that arrived by the first prompt is never
  offered back out by the second.

## [5.11.0] — 2026-10-24

### Changed

- **Wish-list addresses are readable now.** A list's shareable URL names the
  library and the person — `wishlist/<library>/<email>` — instead of a random
  token, or the library's name alone on a server running without sign-in.
  Library names and emails stay case-preserving but match case-insensitively,
  so any casing of the address finds the same page, and the app offers the
  lower-case spelling for sharing. Old token URLs stop working, and the page
  now shows the person's wishes in the library the address names.

## [5.10.0] — 2026-10-24

### Changed

- **Reading status is each member's own, not the copy's.** One member marking
  a book read, loaned or wished-for no longer changes what anybody else sees:
  every member of a library keeps their own status per book, a book somebody
  else added reads as to-be-read until you touch it, and the status filter —
  `wishlist` included — answers against yours alone. Existing statuses carry
  over: every member starts from what the library showed yesterday, except a
  wish-list entry, which stays with its wisher alone (everyone else starts at
  to-be-read). The wish-list purchase record now lives on the wisher's own
  entry, so another member editing a title can neither see, spoil nor disturb
  it.

## [5.9.0] — 2026-10-24

### Added

- **Wish lists.** A new `wishlist` status puts a book on your own wish list —
  yours, not the library's: the wish belongs to whoever set the status, and
  one person's list spans every library they use. Filtering the Books tab to
  the status shows the list's shareable address, and clicking copies the
  address rather than opening it, since the page is for other people. Anyone
  holding the URL may look at the books, signed in or not, and only look. A
  signed-in visitor who is not the list's owner may mark a book as purchased —
  the date they choose, recorded with their own address — and the record then
  replaces the button, so nobody buys a second copy in good faith. The owner
  is told nothing until the purchase date has passed: the server withholds the
  buyer and the date from the owner's own responses until then, so the
  surprise never reaches their browser. Strangers with the URL see only that a
  book is spoken for, never the buyer's address. Taking a book off the list
  retires the entry, purchase and all.

## [5.8.1] — 2026-10-24

### Removed

- **The retired `docker` deploy script.** `deploy/deploy.sh` pulled the
  `ghcr.io` image that CI no longer publishes, so it could not deploy
  anything. Deployment is the Debian package from the registry on
  `forgejo.bobbalisa.org`, installed and upgraded with `apt`; the README
  section describing the old script goes with it, replaced by a pointer at
  the package.

## [5.8.0] — 2026-10-24

### Added

- **A Users tab, for the library's creator alone.** To the right of Genres,
  and shown only to the member who founded the library: list who may sign
  in, add an address, edit one in place (fixing a typo moves the membership
  to the corrected address), or remove it. The server refuses everyone else,
  so a plain member can use the library but not decide who else does.
  Managing users moves out of the account dialog, which keeps the Open
  Library keys and signing out. Each library now records its founder;
  libraries from before the column fall back to their earliest member who
  was not added by somebody, and the server's first library belongs to the
  owner.
- **The Books tab remembers its filters.** The search text and every filter
  dropdown are saved as you use them — per person and per library, since a
  filter names genre, series and shelf ids that mean nothing elsewhere — and
  restored on the next visit. A saved id whose genre, series or shelf has
  since been deleted falls away quietly, and Clear filters forgets them.
- **Subgenres fold away.** On the Genres tab, clicking a parent genre's title
  collapses its subgenres to a single line that says how many are hidden, and
  clicking again brings them back.
- **Clearing the "library book" checkbox shelves the book under its library's
  name.**
  A borrowed book going home now lands on a shelf named after the Library
  field — an existing shelf of that name when there is one, otherwise a new
  bookcase and shelf of that name in a Library room, created on the spot —
  and only then are the Library and Due date fields cleared, so a failure
  leaves them intact to try again.

## [5.7.0] — 2026-10-18

### Added

- **Author and publisher autocomplete.** The book dialog's author and
  publisher fields suggest from what the library already holds — authors
  split out of the comma-separated column, deduplicated case-insensitively;
  publishers distinct — through the same dropdown rooms and bookcases use.
  The authors field completes per segment: typing after a comma suggests and
  completes only the name being typed, leaving the co-authors already
  entered in place. `/api/meta` carries the two lists.

## [5.6.15] — 2026-10-18

### Changed

- **Spines drop a leading article.** "Hobbit", not "The Hobbit" — the way
  sorting already treats titles: on a spine the article spends scarce
  millimetres saying nothing, and its characters now go to the words that
  matter (and to larger type on thin spines). The tooltip keeps the full
  title; the title/author split is computed from the text actually shown.

## [5.6.13] — 2026-10-18

### Fixed

- **Text wraps at the width the fit allows.** The measuring box spanned the
  cell's full length while the fit permitted length-minus-cellpadding, so a
  line could lay out just past the limit WITHOUT wrapping — failing a fit
  that a wrap would have passed, cascading into a floor-clamp and an
  ellipsis for text that fit comfortably
  (`The curse of the House of Foskett`, over by 0.1px on a phone). The box is now exactly as long as
  the fit's limit for the padding in force, so wrapping and fitting agree;
  the `Foskett` title now renders whole on the phone at 4.26px, and the whole
  regression set shows zero truncations on either viewport.

### Changed

- **Wrapped spine text breaks near the centre.** Two-line titles and authors
  balance their lines (`The curse of the / House of Foskett`) instead of
  packing the first line full and leaving a stub — `text-wrap: balance`,
  which the fitter's layout-based measurement picks up for free. (Shipped in
  this release's commit; noted here after the fact.)

## [5.6.12] — 2026-10-18

### Fixed

- **Cross-device spine caching with absolute floors.** The readable font
  floor and the minimum spine width are absolute pixels, which quietly broke
  the cache's assumption that a fitted size scales with the view: a size
  fitted on the phone could wrap and overflow on the laptop ("Violet
  Thistlewaite…" wrapped and needlessly truncated; `Mystekos Fall/Winter`
  truncated on one device, whole on the other). Now a fit that lands on the
  floor is never cached (it refits per view, cheaply), and a cached size
  that fails on the current device is refitted locally before anything is
  truncated — truncation is the last resort, after refitting, after the
  `cellpadding` has already been given up.

## [5.6.11] — 2026-10-18

### Changed

- **Thin spines render wide enough to speak.** A spine never draws narrower
  than one line of floor-size type plus its margins (5px): a 10mm paperback
  at phone scale — or, one day, a magazine — widens past its true scale
  rather than collapsing to a bare ellipsis, and each shelf cell widens to
  the sum of its rendered spines, so a full shelf still contains everything
  it physically holds. The `cellpadding` already yields before any text does;
  and text that survives whole is no longer suffixed with a spurious
  ellipsis, which the truncation pass used to append even when nothing had
  been dropped.

## [5.6.10] — 2026-10-18

### Changed

- **Room headings count bookcases, not shelves.** `Livingroom · 4 bookcases`
  reads at the level the heading groups by; the shelf counts stay on each
  bookcase's own line.

## [5.6.9] — 2026-10-18

### Changed

- **The spine font is bundled and pinned.** Spine text now renders in
  `Roboto Condensed` (`latin` + `latin-ext` woff2, ~44KB, served from the
  bundled `npm` package like the scanner libraries, so offline use keeps working) instead
  of system-ui, which differs between a phone and a laptop — and with it
  differed every fitted size, wrap and truncation. Fitting waits for the
  font to load, so nothing is ever measured against a fallback face; a
  condensed face also fits more text per millimetre of spine, which is why
  real book spines use them.

## [5.6.8] — 2026-10-18

### Changed

- **A readable floor for spine text: 3.4px, then ellipsis.** Calibrated just
  under the ~3.7px that the smallest spine a reader accepted fits at; a 7mm
  spine's ~2.3px smear was unreadable at any zoom. A spine whose text cannot
  fit at the floor keeps the floor, gives up its `cellpadding`, and is
  truncated along the spine instead — longest prefix that fits, found
  against real layout, down to a bare "…" on a spine too thin for any glyph
  — with the full text still in the tooltip. The floor also holds at render
  time, so a cached font scaled down by a smaller viewport clamps up and
  truncates rather than shrinking below it.

### Fixed

- **Hairline overflow at the cell edge on thin spines.** Antialiasing bleeds
  about a pixel past the measured ink, which let the ~4px author text of
  `Mystekos Spring` kiss and cross the cell's right edge; the fit now keeps
  a 0.75px margin on every side.

## [5.6.7] — 2026-10-18

### Changed

- **Shelf labels moved into the `cellspacing` below their shelf.** The label
  ("A1", or "A1 · Horror") now sits centered in the strip of bare bookcase
  under its cell, in ink that contrasts with the bookcase's color, sized to
  the strip (8px in the 10px gap) — so it cannot overlap a book, however
  full the shelf. Clicking it still edits the shelf.

## [5.6.6] — 2026-10-18

### Fixed

- **Spine text is laid out flat and rotated by transform.** Where an engine
  anchors sideways glyphs inside a vertical-rl line column is not reliably
  the documented model, and every mis-guess showed as spines crowding one
  edge ("Belladonna", "Heroes' Feast", "Apology"…). The text now lays out
  HORIZONTALLY — the one writing mode whose baseline arithmetic is
  dependable, with each baseline anchored by line index — is measured as
  real glyph ink via canvas TextMetrics, and is then rotated 90° clockwise
  and placed by transform so the ink sits dead centre in the cell. Verified
  against the rendered pixels: a harness screenshots the bookcase and
  measures every cell's ink margins; 29 of 30 cells are symmetric to within
  2px, the 30th being a 4px-font cell where antialiasing dominates.
- **The cell tag moved to the top-right corner.** Books pack from the left,
  so the "A1" chip sat on the first books' heads and ate the tops of their
  titles; the top-right corner is the part of a shelf that fills last.

## [5.6.5] — 2026-10-18

### Fixed

- **Spines fit and center on their true glyph ink.** Three lies are gone. The
  fitting pass trusted scrollWidth/scrollHeight, which under-report overflow
  in vertical writing modes — half-shaved final letters ("Foxglove"). At
  line-height 1.1 the system fonts' bounding box (≈1.17em) is taller than
  the line box, so ascender ink protruded past the text box's own clip —
  clipped first-line tops ("Violet Thistlewaite…"). And line boxes reserve
  ascent and descender allowances no glyph may use, so ink sat visibly off
  centre ("Heroes' Feast"). The text is now measured as actual ink — each
  rendered line read back from layout, its glyphs measured by canvas
  TextMetrics from its baseline — the fit is strict against that ink plus
  the `cellpadding`, the final font sits 3% below the maximum so rounding can
  never clip, the text box no longer clips (only the cell does), and a
  transform centres the measured ink in the cell both ways. Live cached
  typography is cleared at deploy so every spine refits.

## [5.6.4] — 2026-10-18

### Fixed

- **Spine centering holds for every text.** `width: fit-content` still
  inherited the engine's estimate of how many lines the rotated text needs,
  and for some texts (`Brigands & Breadknives`) that is a whole line more
  than the breaks produce — the phantom column defeated the centering. After
  the font settles, each cell's text box is now pinned to its measured ink
  extent (the union of its line rectangles), which cannot disagree with the
  actual lines. Runs on cached and freshly fitted spines alike.

## [5.6.3] — 2026-10-18

### Fixed

- **Spine text centers with symmetrical blank space.** The rotated text box,
  left at its automatic size, could come out wider than its stack of lines;
  the lines then clung to its right edge (vertical-rl's line-start) and the
  slack piled up on the left, reading as zero `cellpadding` on one side. The
  box now hugs its lines exactly (`width: fit-content`), so the cell's
  centering alone places it: left = right and top = bottom, measured to the
  pixel in the driver.

## [5.6.2] — 2026-10-18

### Changed

- **Virtual bookcases show only their book counts.** A bookcase none of whose
  shelves has any dimension — an e-reader, a public library's branches, a
  want-to-buy list — is virtual: its shelf cards drop the "— × — × — mm" line
  and the "Set a width to track capacity." nag and show just "N books".
  Setting any dimension on any shelf makes the whole bookcase physical again.

## [5.6.1] — 2026-10-18

### Changed

- **Spine typography polish.** Titles and authors are centered across the
  spine's width (and along their cell); each cell carries 0.15em of padding —
  scaling with the fitted font, so always at least the 0.1em of blank space
  line-height 1.1 leaves between wrapped lines — and the visible boundary
  between the title and author cells is gone. Text wraps on spaces only: a
  word too long for the cell shrinks the font until it fits on one line,
  rather than breaking mid-word ("Thistlefo/ot"). The fitting pass accounts
  for the padding; existing cached spine typography is cleared by hand on the
  live database so every spine is refitted under the new geometry.
- **Full shelves no longer overflow their cell.** Spines sit flush — the 1px
  gap and side padding that added phantom width per book are gone, and spine
  widths keep their fractional pixels instead of rounding, so a shelf drawn
  with exactly the books it really holds fits exactly.

## [5.6.0] — 2026-10-18

### Changed

- **Spines show the whole title and author.** Each spine in the visual view is
  now a two-celled mini-table — title above, author below, a hairline between
  — with the text rotated as before but word-wrapped and shrunk to fit rather
  than ever truncated: nothing is cut short, however small it must go (zoom the
  page to read the tiny ones). Title and author within one book share a font
  size, found per book by binary search against real layout, so neighbouring
  books differ; the spine's length is split between the two cells in
  proportion to how much text each holds, so a short title with a long author
  gets a small title cell and a large author cell.

### Added

- **Cached spine typography.** The fitted font size (stored normalised to a
  scale of 1 px/mm, so one value serves phone and desktop) and the title
  cell's share are saved per copy — `copies.spine_font`, `copies.spine_split`,
  written through `POST /api/spine-fonts` — so later views skip the fitting
  pass. The server clears the cache whenever an input changes: the title,
  authors, dimensions or format of the edition, the copy moving to another
  shelf, or the shelf's dimensions changing.

### Removed

- **The schema-upgrade and label→cell backfill code from 5.5.0.** The one
  known deployment's database is migrated by hand (and already was); a fresh
  database starts with every column. No general upgrade path, less to carry.

## [5.5.0] — 2026-10-18

### Added

- **Shelf cells and visual bookcases.** Each shelf can carry a `cell` — its
  spot in the bookcase grid as a spreadsheet-style coordinate, "A1" the top
  left — separate from the label, which stays free text. On the Shelves tab a
  bookcase with cells renders as that grid: every book a spine scaled from its
  dimensions (or, unmeasured, the average of the library's hardbacks or
  softcovers, falling back to constants measured over the `Bobbalisa` library),
  colored by averaging the left border of its cover image — grey without a
  cover — and titled down the spine in black or white, whichever contrasts.
  Clicking a spine opens the book; a List/Visual toggle per bookcase is
  remembered in the browser. `/api/meta` now reports `avg_dims` per cover type.
- **Bookcase colors.** The bookcase dialog gains a color: a grid of standard
  swatches, or 📷 Scan, which photographs a patch of the real bookcase and
  averages every pixel. The color backs the visual grid (white by default),
  lives on each shelf row (`shelves.bookcase_color`), and so follows moves,
  merges and copies; `PUT`/`POST /api/bookcases` accept `color`.
- **Add bookcase.** A new dialog (and `POST /api/bookcases` without `from`)
  creates a rows × columns bookcase in one go, each shelf named for its cell
  until it earns a real label.
- **Copy dimensions across a bookcase.** Saving a shelf that has a cell offers
  to copy its depth to every shelf of the bookcase, its width down the column,
  and its height across the row — each preselected only where it would change
  something, and nothing written without confirmation.
- **One-time cell backfill.** A database gaining the `cell` column derives
  cells from the labels: pure coordinates ("1L", "2M") become cells and are
  relabelled to the new notation ("1L" → "A1"; columns are whichever of L/M/R
  the bookcase uses, left to right), labels that only lead with a row number
  ("2", "1 - Top") get column A and keep their text, and anything else is left
  alone — as is any bookcase whose labels would derive the same cell twice.

- **Listening on a Unix socket.** `SOCKET_PATH` serves on a socket file
  instead of `PORT`, for a web server in front, and `SOCKET_MODE` sets who may
  connect to it. A socket handed over by `systemd` socket activation
  (`LISTEN_FDS`) wins over both, which is how the Debian package runs the app:
  the socket's owner, group and mode are then set in its `.socket` unit. With
  none of them set the app listens on `PORT` as before, so the Docker image is
  unchanged. `listen.js` chooses; `test/listen.test.mjs` covers the choice and
  serves a request over a socket.
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
  aborts an `addon` built on `node::ObjectWrap` when garbage collection frees one
  of its objects. `better-sqlite3` 11 was such an `addon`; 12 onwards uses
  `Napi::ObjectWrap` and is not affected. The new stress test aborts on
  `better-sqlite3` 11.10.0 with Node 24.21.0 and passes on 13, on both Debian
  and Alpine. The Docker image and CI now follow `node:24`.
- **Smaller Docker image: 654 MB to 287 MB.** `better-sqlite3` compiles from
  source on every install, so the image carried the compiler `toolchain`
  (`python3`, `make`, `g++`, about 280 MB) it needed only while building. A
  two-stage build now compiles in the first stage and copies just
  `node_modules` into a clean runtime image.

### Fixed

- **The Alpine image would have judged due dates in UTC.** `node:alpine` ships
  no `zoneinfo`, so its C library ignored `TZ` and so did SQLite, while Node's own
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
  of `Unshelved`. With no shelf filter it still opens `Unshelved`.

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
  no longer needs `prebuild-install`; `sharp` 0.35.5 fixes its `libvips` and
  `libheif` advisories, and an override moves the scanner library's bundled
  `sharp` onto it; `npm audit fix` updated `qs` under `express` and the linters'
  dependencies. `ESLint` 9 turned out to be deprecated as well, which `npm ci`
  never said: it is now `ESLint` 10, whose `no-useless-assignment` rule removed
  four dead `= null` `initialisers`.
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

- **The phone header still wrapped on the wider fonts in CI**, with 13px to spare
  where 24px is asked for. Every header button, not only ⚙, now has narrower
  side padding.
- **Node 24.18.1, pinned.** Every 24.x release from 24.19.0 on can abort
  `better-sqlite3` while freeing a statement during garbage collection
  ([nodejs/node#65446](https://github.com/nodejs/node/issues/65446)). It crashed
  a test file on CI at 24.21.0, and a floating `node:24-slim` would have shipped
  it. The Docker image and CI stay on 24.18.1 until that is fixed.

## [5.0.1] — 2026-09-28

### Fixed

- **"+ Add book" wrapped onto its own line on a phone.** The ⚙ Account button
  added in 5.0.0 left the header's button row 17px short of full at 412px,
  so wider fonts pushed the last button down. The icon button is narrower and
  the row's gaps tighter, and the header test now demands room to spare.

### Changed

- **Node.js 24.** The Docker image, CI and `engines` move from Node 20 and 22
  to 24, and the CI actions move to their Node 24 releases.

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
- **The header names the library**: `📚 Bobbalisa Library` instead of "Home
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
  `Bobbalisa` is created, everything already in the database becomes its, and
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
  looking just like a refusal. A send now retries a _thrown_ fetch a few times
  with a short `backoff`, while a _returned_ response — even a `403` — is still
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
  disagreeing with us.** Some requests are answered by the `nginx` in front of
  Open Library and never reach it at all; the message now says so. One cause is
  identified by name: a `PUT` whose body contains a quote followed by `--` is
  refused with a bare `403`. That is the SQL comment injection signature, and a
  MARC-derived description routinely ends `"--` before its source attribution —
  so a record carrying one cannot have _any_ blank field filled through the API,
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
  there ↗**, with a line saying that the picker opens _Photos_ on a phone while
  the saved image is under _Files → Downloads_.

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
  Covers are the one contribution that goes through a browser _form_ rather than
  the JSON API, and Open Library has put those behind a human-verification
  challenge that a bot account cannot pass. Measured against the live site: an
  authenticated `PUT` of a record reaches the handler, an authenticated
  multipart `POST` to `add-cover` gets `405` from their front end — before
  routing, since a nonexistent OLID gets it too — and an anonymous one is sent
  to `/verify_human`. Nothing here can be retried and nothing is configured wrongly, so
  the message says so instead of echoing a status code that reads like a bug in
  this app. **Every other contribution is unaffected.**
- A cover POST that is redirected to the verification or login page is no longer
  counted as a success. Any `302`/`303` used to mean "sent", which would have
  marked a contribution delivered that Open Library never took.

## [4.0.5] — 2026-09-22

### Changed

- **A sign-in now slides instead of expiring on a fixed date.** It was an
  absolute 30 days from signing in, so somebody who used the library daily was
  still bounced to Google on the thirtieth day. It is now ten days of _not_
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
  withdrawn its `tailnet` route, which is what reaches phones off the LAN. `nginx`
  stayed bound to the VIP through `ip_nonlocal_bind`, so connections hung rather
  than being refused, and the address did not even ping.

  There is now a `/healthz` route, mounted in front of the gate, and
  `deploy.sh`, `failover.sh` and `failover-peer.sh` all ask for it. A probe
  carries no identity and cannot be sent through an `OAuth` redirect, so refusing
  it says nothing about the app. It reads from the database rather than merely
  answering, because an app that cannot read the library is not one to hand the
  VIP to.

## [4.0.3] — 2026-09-22

### Added

- **Sign in with Google.** Setting `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
  puts every page and every API route behind a Google account; leaving them
  unset leaves the app open exactly as before, and the startup banner says which
  of the two it is doing. Sessions are signed cookies (`SESSION_SECRET`,
  `SESSION_TTL_DAYS`), the flow uses PKCE and a state cookie, and the `OAuth`
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
- The header no longer reports how many books sit on no shelf. It was a running
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
  handoff, and an `rsync` of the directory for the hourly copy, which is where
  `rsync` earns its keep since almost nothing changes between runs.

  The API is unchanged: covers were already returned as `api/books/:id/cover`
  references rather than bytes.

- `eslint.config.js` matches server-side modules by glob rather than by a list of
  filenames. `covers.js` was linted without Node `globals` purely because nobody
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
  kept-back original; both are `falsy`, and nothing read it any other way.

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
  — fingerprinting the database _and_ its WAL, since in WAL mode the main file's
  contents can sit unchanged through a busy hour. A peer that is simply offline
  logs to the journal and exits 0, because an hourly `cron` mail about a known-down
  standby is how people learn to ignore `cron` mail; anything else fails loudly.

  The copy lands in `<data dir>/standby/library.db` on the peer and never on the
  peer's own `library.db`: overwriting that would bypass `assert_generation_ok()`,
  which exists to refuse replacing a copy a later handoff produced. It is a
  disaster copy, restored deliberately, not a replication channel. Transport is a
  dedicated key pinned to `rrsync -wo`, which can only write and only into that
  directory — the failover key is pinned to the verb script and deliberately has
  no path to `rsync`.

### Fixed

- **The failover snapshots were not backups.** `snapshot_local()` and the peer's
  `db-snapshot` verb both took a timestamped **hard link** — another name for the
  same `inode`. SQLite writes in place, so all ten "generations" tracked the live
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

- **An edition is identified by ISBN _and_ format**, not by ISBN alone. In
  principle one ISBN means one format, since a hardback and a paperback are
  separately numbered — but e-books have an ASIN rather than an ISBN, and importers
  staple the print ISBN onto the e-book record. Matching on the ISBN alone fused
  Kindle files to hardbacks: the merged record kept one format and the other's
  physical dimensions, so a hardback on a shelf reported itself as an e-book.
  Changing a copy's format now moves it to its own edition rather than rebinding
  every copy that shares the ISBN.

- **Every ISBN is canonicalised to ISBN-13 before it is stored.** `0441013597`
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
  no-op. `TZ` therefore belongs in the `env` file passed to the container — setting it
  via `systemd` `Environment=` looks right and does nothing, because that reaches the
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
  filter disagree for a few hours each night. A book due _today_ is not overdue.

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
  refusal to overwrite a copy produced by a later handoff. `mtime` values are logged as a
  diagnostic but deliberately do **not** gate anything — merely opening a SQLite
  database updates its `mtime`, so a standby started for any reason would otherwise
  look newer than the rightful owner and block the next legitimate handoff.

  If the peer cannot be reached, the node never guesses: it keeps its own copy only
  when its own marker already names it as owner, and does so _without_ advancing the
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
  while it was in fact serving, so `systemd` disagreed with reality and — the part that
  actually bit — the receiver's next shutdown ran no ExecStop and handed nothing back.

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
- Metadata source hosts can be overridden (`OPENLIBRARY_BASE`, `GOOGLE_BOOKS_BASE`,
  `BARNESNOBLE_BASE`), so a mirror or a test stub can stand in. They default to
  the real services.

## [2.1.0] — 2026-07-21

### Added

- When a scanned ISBN finds no metadata, the app offers a re-scan rather than a
  dead end. A 1D barcode can misread into a _different_ number whose check digit
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
  Docker under `systemd` — see the README. `git log` has them if they are ever
  wanted back.

### Changed

- Nothing in the shipped app names one particular deployment any more. The
  "camera needs HTTPS" advice pointed at one home lab's `Tailscale` URL, which is
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
