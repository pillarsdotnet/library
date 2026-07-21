# Changelog

Notable changes to this project. The [README](./README.md) describes the app as
it stands now; this file is where the history lives.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
