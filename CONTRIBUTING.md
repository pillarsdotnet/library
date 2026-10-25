# Contributing to Home Library

How the codebase is put together and how changes land in it. For installing
and operating the app, see [INSTALLING.md](INSTALLING.md); for what the app
does, see the [README](README.md).

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
named by the SHA-256 of its bytes — so the same photo stored for two copies (an
`ebook` reusing the printed edition's cover, say) is one file, automatically.
The row holds only that filename and `cover_token`, a short prefix of the same
hash. Because the file is shared, deleting goes through a reference count: a
file is removed only when the last row naming it lets go (`dropCover` in
`server.js`).

**A copy of `library.db` on its own is therefore not a backup.** Every row
naming a missing file is a broken picture, so the covers directory has to travel
with it. Both mechanisms here already do: the handoff moves it through the
`covers-send`/`covers-recv` verbs, and the hourly sync carries it alongside with
`rsync` (both in [INSTALLING.md](INSTALLING.md)).

The API returns a cover as a reference to `api/books/:id/cover?v=<token>`, never
as bytes. The token is what makes the URL change when the image does — without
it a browser holding a cached copy goes on showing the old photo after a new one
is saved, which looks exactly like the save having failed. Because a versioned
URL names one particular image forever, it is served `immutable`.

Queries that return books select an explicit column list (`BOOK_SELECT` in
`server.js`) rather than `b.*`: the query says exactly what it reads, and
nothing heavy can ride into every listing unnoticed.

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
   instead — `/etc/home-library/home-library.env` on the node, or locally:

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
