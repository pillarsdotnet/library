---
name: run-library
description: Build, run, screenshot and drive the Home Library app (this repo) — start the server, add a book through the real UI, screenshot a phone or desktop layout, evaluate JavaScript in the running page, or call the REST API. Use when asked to run, start, launch, serve, smoke-test, screenshot, or verify a change in the actual app rather than in tests.
---

# Run the Home Library app

An Express + SQLite web app with a vanilla-JS front end in `public/`. There is
no build step and no framework — the server serves `public/` directly.

Everything here is driven by **`.claude/skills/run-library/driver.mjs`**, which
starts the app on a throwaway database, seeds it with six books and two
shelves, and drives the page with `puppeteer-core`. Prefer it over `npm start`:
`npm start` serves `./data/library.db` (a real library on a real deployment)
and then blocks forever with no handle on the browser.

Paths below are relative to the repository root.

## Prerequisites

```bash
node --version          # v24.18.1 here; package.json requires >=20
npm ci                  # ~6s
google-chrome --version # any recent build; this box auto-updates (153.0.7979.3 dev)
```

`npm ci` prints `npm warn allow-scripts` for `sharp` and `better-sqlite3`.
Ignore it — both load fine (`node -e "require('better-sqlite3'); require('sharp')"`).

`puppeteer-core` **never downloads a browser**; it drives whatever Chrome is on
the box. The driver looks at `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`,
`/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`,
`/usr/bin/chromium-browser`, and tells you if it finds none. No build, no
bundler, no `xvfb` — Chrome runs headless.

## Run: the driver (agent path)

Every command starts the server on port 3210 at `/library`, seeds demo data,
and cleans up its scratch database on exit.

```bash
# End-to-end: add a book through the real dialog, verify it lists, screenshot.
node .claude/skills/run-library/driver.mjs smoke
```
```
books 6 → 7, added "Driver Smoke 1785695975654"
screenshot /tmp/library-shots/smoke.png
PASS
```

`smoke` exits non-zero if the book never appears or a tab renders empty. It is
the fastest way to confirm the app still works after a change.

```bash
# Screenshots. Default viewport is a 412x870 phone — this app is used on one.
node .claude/skills/run-library/driver.mjs shot --out /tmp/library-shots/phone.png

# Desktop, two clicks deep, cropped to one element:
node .claude/skills/run-library/driver.mjs shot --desktop \
  --click '#addBtn' --selector '#editDialog' --out /tmp/library-shots/dialog.png

# The barcode scanner, running against Chrome's fake camera:
node .claude/skills/run-library/driver.mjs shot \
  --click '#addBtn,#scanBtn' --selector '#editDialog' --settle 3000 \
  --out /tmp/library-shots/scanner.png
```

Screenshots default to `/tmp/library-shots/` (`LIBRARY_SHOT_DIR` overrides).
**Open the PNG and look at it** — the driver reports page errors, but only your
eyes catch a layout that is merely wrong.

```bash
# Reach into the live page. `$` and `$$` are provided; the result must be JSON.
node .claude/skills/run-library/driver.mjs eval '$$(".card").length'
node .claude/skills/run-library/driver.mjs eval \
  '({ all: $$(".card").length, inBooks: $$("#tab-books .card").length })'
```
```
{ "all": 8, "inBooks": 6 }
```

```bash
# The REST API, without a browser.
node .claude/skills/run-library/driver.mjs api GET /api/meta
node .claude/skills/run-library/driver.mjs api POST /api/books '{"title":"X","authors":"Y"}'
```

Useful flags: `--desktop` (1280x900), `--no-seed` (empty library), `--url PATH`,
`--click 'a,b'` (comma-separated, in order), `--settle MS`, `--full` (full-page
screenshot), `--port N`, `--base PATH` (mount point, default `/library`),
`--verbose` (server logs), `--keep`, `--online` (allow real Open Library /
Google Books lookups), `--db PATH` (**writes to that database** — point it at a
copy, never at live data).

## Run: without the browser

```bash
# Direct invocation — the layer most changes actually touch.
node -e "import('./isbn.js').then(m => console.log(m.canonicalIsbn('0441013597')))"   # 9780441013593
node -e "import('./sorttitle.js').then(m => console.log(m.sortTitle('The Hobbit')))"  # hobbit
```

`public/app.js` is a classic script with no exports; `test/unit.test.mjs`
extracts single functions from it by name (`loadFunction`) — copy that trick
rather than trying to import it.

## Run: human path

```bash
node .claude/skills/run-library/driver.mjs serve --port 3213
```
```
serving http://127.0.0.1:3213/library/
database /tmp/library-run-1543181/library.db
Ctrl-C to stop.
```

Stop it with Ctrl-C, which removes the scratch database. (Don't
`pkill -f driver.mjs` — the pattern also matches the shell that launched it,
and kills your own command.)

`npm start` is the production path: port 3000, no mount path, and it writes
`./data/library.db`. Use it only when you mean to touch real data.

## Test

```bash
npm test                    # 182 tests, ~90s (spawns servers and headless Chrome)
npm run lint                # eslint + stylelint; the pre-commit hook runs this
node --test test/unit.test.mjs                                          # fast, no browser
node --test --test-name-pattern "phone header" test/scanner.browser.test.mjs
```

## Gotchas

- **The camera only works on `127.0.0.1`.** Over plain HTTP, `127.0.0.1` is a
  secure context and the LAN address is not — verified on this machine:
  `127.0.0.1` → `isSecureContext: true`, `getUserMedia: true`; `10.0.0.7` →
  `false` / `false`, i.e. `navigator.mediaDevices` is `undefined` and the ISBN
  scanner cannot start at all. Never point the driver at a hostname or LAN IP.
- **Chrome needs the fake-camera flags** (`--use-fake-device-for-media-stream`,
  `--use-fake-ui-for-media-stream`) or the scanner hangs on a permission prompt
  no one can click. The driver passes them; so does the browser test suite.
- **Covers collide if two servers share a covers directory.** Covers live in
  `covers/` beside the database and are named after the copy id, which restarts
  at 1 in every fresh database — two runs sharing `/tmp/covers` overwrite each
  other's images. The driver gives every run its own `DB_PATH` **and**
  `COVERS_DIR`; do the same in any new test.
- **`.card` matches shelf cards too.** The other tabs are `hidden`, not
  unmounted, so `$$(".card")` returns 8 for 6 books. Scope to `#tab-books`.
- **Screenshot after `networkidle0`, not `domcontentloaded`.** The list is
  fetched after load; the driver already waits, but any ad-hoc puppeteer script
  will otherwise capture an empty grid.
- **A page load is not a settled dialog.** `--click` waits for the selector and
  then 600ms; the scanner needs `--settle 3000` before the video has frames.
- **Never `pkill chrome`** to clean up — it kills the user's real browser. The
  driver only ever kills the browser process it launched.
- **Lookups are pointed at a dead port** (`127.0.0.1:1`) unless you pass
  `--online`, so an ISBN lookup fails instantly instead of hanging on
  openlibrary.org. Expect "not found" in the dialog; that is the driver, not a bug.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `shot failed: ENOENT ... open '/tmp/x/y.png'` | The output directory did not exist. Fixed in the driver (it creates parents); if you write your own puppeteer script, `mkdirSync` first — puppeteer does not. |
| Command hangs for minutes, no output | A puppeteer error before `browser.close()` leaves Chrome running and node's event loop alive. The driver closes it in a `finally`; a hand-rolled script must too. |
| `eval failed: $$ is not defined` | `$$` only exists inside the driver's `eval` wrapper; `public/app.js` defines `$` alone. |
| `server did not answer on http://127.0.0.1:3210/library/ within 20s` | Something else holds the port — `--port 3299`. Or run with `--verbose` to see the server's own error. |
| `No Chrome found` | Set `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`. `puppeteer-core` bundles no browser. |
| Test failure mentioning `/tmp/covers` | Two test servers sharing a covers directory — see the covers gotcha above. |
