#!/usr/bin/env node
// Drive the Home Library app: start it on a throwaway database, seed enough
// books to make a screen worth looking at, and reach into the running page.
//
// Why this exists rather than `npm start`: `npm start` serves ./data/library.db
// — a real library on a real deployment — and then waits forever with no handle
// on the browser. Everything here runs against a scratch database in /tmp and
// exits cleanly, so it is safe to run repeatedly and safe to run on a machine
// that holds real data.
//
//   node .claude/skills/run-library/driver.mjs shot --out /tmp/x.png
//   node .claude/skills/run-library/driver.mjs smoke
//   node .claude/skills/run-library/driver.mjs eval '$$(".card").length'
//   node .claude/skills/run-library/driver.mjs api GET /api/meta
//   node .claude/skills/run-library/driver.mjs serve        # stays up
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOT_DIR = process.env.LIBRARY_SHOT_DIR || '/tmp/library-shots';

// puppeteer-core never downloads a browser, so the path has to come from
// somewhere. These are where a Debian/Ubuntu container actually puts one.
function findChrome() {
  const found = [
    process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean).find((p) => existsSync(p));
  if (!found) {
    console.error('No Chrome found. Install one (apt-get install -y google-chrome-stable)\n'
      + 'or point PUPPETEER_EXECUTABLE_PATH at it.');
    process.exit(1);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
// Flags that never take a value, so `--desktop /tmp/x.png` does not swallow the
// path as if it were `--desktop`'s argument.
const BOOLEAN = new Set(['desktop', 'full', 'keep', 'no-seed', 'headful', 'verbose', 'online']);

const argv = process.argv.slice(2);
const cmd = argv.shift() || 'help';
const positional = [];
const flags = {};
while (argv.length) {
  const a = argv.shift();
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const [key, inline] = a.slice(2).split('=');
  if (inline !== undefined) flags[key] = inline;
  else if (BOOLEAN.has(key) || !argv.length || argv[0].startsWith('--')) flags[key] = true;
  else flags[key] = argv.shift();
}

const PORT = Number(flags.port || 3210);
const BASE_PATH = flags.base ?? '/library';
const URL_ROOT = `http://127.0.0.1:${PORT}${BASE_PATH}/`;
// A scratch database per driver run, with its own covers directory beside it —
// covers default to `covers/` next to the database, and two runs sharing one
// directory overwrite each other's files (copy ids restart at 1).
const SCRATCH = `/tmp/library-run-${process.pid}`;
const DB_PATH = flags.db ? resolve(flags.db) : join(SCRATCH, 'library.db');
const COVERS_DIR = join(dirname(DB_PATH), 'covers');

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------
let server = null;
// Held so cleanup can close it on the error path too. A browser left open keeps
// node's event loop alive: an early failure then hangs for ever instead of
// reporting itself, which is exactly what this driver did on its first run.
let browser = null;

async function startServer() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      BASE_PATH,
      DB_PATH,
      COVERS_DIR,
      // Keep a driver run off the public catalogues: a lookup would otherwise
      // reach openlibrary.org, which is slow, rate-limited, and unavailable in
      // a sandbox. 127.0.0.1:1 refuses instantly, so lookups fail fast instead
      // of hanging the page for a minute.
      OPENLIBRARY_BASE: 'http://127.0.0.1:1',
      GOOGLE_BOOKS_BASE: 'http://127.0.0.1:1',
      BARNESNOBLE_BASE: 'http://127.0.0.1:1',
      ...(flags.online ? { OPENLIBRARY_BASE: undefined, GOOGLE_BOOKS_BASE: undefined, BARNESNOBLE_BASE: undefined } : {}),
    },
    stdio: flags.verbose ? 'inherit' : 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${URL_ROOT}api/meta`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not answer on ${URL_ROOT} within 20s`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return URL_ROOT;
}

const api = async (method, path, body) => {
  const r = await fetch(URL_ROOT.replace(/\/$/, '') + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
};

// Enough furniture that every tab shows something: two shelves in two rooms,
// books across the statuses, one overdue library book, one with a cover.
async function seed() {
  const cover = `data:image/png;base64,${readFileSync(join(ROOT, 'test/fixtures/sample-cover.png')).toString('base64')}`;
  const today = new Date();
  const day = (n) => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);

  const shelf = (await api('POST', '/api/shelves', {
    room: 'Study', bookcase: 'Oak', label: 'Top', height_mm: 300, width_mm: 900, depth_mm: 250,
  })).body;
  await api('POST', '/api/shelves', {
    room: 'Bedroom', bookcase: 'Pine', label: 'Middle', height_mm: 260, width_mm: 700, depth_mm: 200,
  });

  const books = [
    { title: 'The Hobbit', authors: 'J. R. R. Tolkien', isbn: '9780261102217', status: 'read',
      format: 'paperback', page_count: 310, height_mm: 198, width_mm: 129, thickness_mm: 22,
      shelf_id: shelf.id, cover_url: cover },
    { title: 'Dune', authors: 'Frank Herbert', isbn: '9780441013593', status: 'reading',
      format: 'paperback', page_count: 617, height_mm: 210, width_mm: 140, thickness_mm: 40, shelf_id: shelf.id },
    { title: 'A Wizard of Earthsea', authors: 'Ursula K. Le Guin', isbn: '9780553262506',
      status: 'tbr', format: 'hardback', page_count: 183, height_mm: 240, width_mm: 160, thickness_mm: 18 },
    { title: 'Snow Crash', authors: 'Neal Stephenson', isbn: '9780553380958', status: 'loaned',
      loaned_to: 'Alex', format: 'paperback', page_count: 440 },
    { title: 'Piranesi', authors: 'Susanna Clarke', is_library_book: 1, library_name: 'City Library',
      due_date: day(-3), status: 'reading', format: 'hardback', page_count: 245 },
    { title: 'The Left Hand of Darkness', authors: 'Ursula K. Le Guin', is_library_book: 1,
      library_name: 'City Library', due_date: day(9), status: 'tbr', format: 'paperback' },
  ];
  for (const b of books) await api('POST', '/api/books', b);
  return (await api('GET', '/api/meta')).body;
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------
async function openPage() {
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: flags.headful ? false : 'new',
    args: [
      '--no-sandbox',                        // required as root in a container
      '--disable-dev-shm-usage',             // /dev/shm is tiny in containers
      '--use-fake-device-for-media-stream',  // the ISBN scanner wants a camera
      '--use-fake-ui-for-media-stream',      // ...and would otherwise prompt
    ],
  });
  const page = await browser.newPage();
  await page.setViewport(flags.desktop
    ? { width: 1280, height: 900 }
    : { width: 412, height: 870, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // Anything the page complains about is reported: a driver that hides a
  // ReferenceError produces a screenshot of a half-built page and calls it fine.
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));

  // networkidle0 matters: the list is fetched after load, so domcontentloaded
  // screenshots an empty grid.
  await page.goto(URL_ROOT + (flags.url ? String(flags.url).replace(/^\//, '') : ''), { waitUntil: 'networkidle0' });
  return { page, problems };
}

// Screenshots go to a directory that may not exist yet — puppeteer does not
// create one, it just fails with ENOENT after the whole run has happened.
const shotPath = (nameOrPath) => {
  const out = nameOrPath.includes('/') ? resolve(nameOrPath) : join(SHOT_DIR, nameOrPath);
  mkdirSync(dirname(out), { recursive: true });
  return out;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdServe() {
  await startServer();
  if (!flags['no-seed']) await seed();
  console.log(`serving ${URL_ROOT}`);
  console.log(`database ${DB_PATH}`);
  console.log('Ctrl-C to stop.');
  await new Promise(() => {});   // hold the process open
}

async function cmdShot() {
  await startServer();
  if (!flags['no-seed']) await seed();
  const { page, problems } = await openPage();
  // Comma-separated so a screen two clicks deep is still one command
  // (`--click '#addBtn,#scanBtn'` opens the dialog, then starts the scanner).
  // Selectors containing a comma are the price; none of this app's need one.
  for (const sel of String(flags.click || '').split(',').filter(Boolean)) {
    await page.waitForSelector(sel.trim(), { visible: true });
    await page.click(sel.trim());
    await new Promise((r) => setTimeout(r, Number(flags.settle || 600)));
  }
  const out = shotPath(String(flags.out || `library-${Date.now()}.png`));
  const target = flags.selector ? await page.$(String(flags.selector)) : page;
  if (!target) throw new Error(`no element matches ${flags.selector}`);
  await target.screenshot({ path: out, fullPage: !flags.selector && !!flags.full });
  console.log(out);
  if (problems.length) console.error(`page problems:\n  ${problems.join('\n  ')}`);
}

// The flow a person actually performs: open the add dialog, fill it in, save,
// and confirm the book is on screen afterwards. Exits non-zero if it is not.
async function cmdSmoke() {
  await startServer();
  const meta = flags['no-seed'] ? { count: 0 } : await seed();
  const { page, problems } = await openPage();
  const title = `Driver Smoke ${Date.now()}`;
  const fail = [];

  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  await page.type('#bookForm [name="title"]', title);
  await page.type('#bookForm [name="authors"]', 'A. Driver');
  await page.click('#bookForm button[type="submit"]');
  await page.waitForFunction(
    (t) => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes(t)),
    { timeout: 10000 }, title,
  ).catch(() => fail.push('the new book never appeared in the list'));

  const after = (await api('GET', '/api/meta')).body;
  if (after.count !== meta.count + 1) fail.push(`count went ${meta.count} → ${after.count}, expected +1`);

  // The tabs are the other half of the app; a broken one shows an empty panel.
  for (const [tab, panel] of [['shelves', '#tab-shelves'], ['genres', '#tab-genres']]) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForSelector(`${panel}:not([hidden])`);
    const filled = await page.$eval(panel, (el) => el.textContent.trim().length > 0);
    if (!filled) fail.push(`${tab} tab rendered empty`);
  }
  await page.click('.tab[data-tab="books"]');

  const out = shotPath('smoke.png');
  await page.screenshot({ path: out });

  console.log(`books ${meta.count} → ${after.count}, added "${title}"`);
  console.log(`screenshot ${out}`);
  if (problems.length) console.log(`page problems:\n  ${problems.join('\n  ')}`);
  if (fail.length) { console.error(`FAIL\n  ${fail.join('\n  ')}`); process.exitCode = 1; } else console.log('PASS');
}

async function cmdEval() {
  const expr = positional.join(' ');
  if (!expr) throw new Error("usage: eval '<javascript>'  (runs in the page; $ and $$ are the app's own helpers)");
  await startServer();
  if (!flags['no-seed']) await seed();
  const { page, problems } = await openPage();
  // app.js defines `$` but no `$$`, and its top-level consts are not reliably
  // reachable from an injected expression, so both are supplied here. The result
  // has to survive JSON: a DOM node comes back as {}.
  const value = await page.evaluate(`(async () => {
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    return (${expr});
  })()`);
  console.log(JSON.stringify(value, null, 2));
  if (problems.length) console.error(`page problems:\n  ${problems.join('\n  ')}`);
}

async function cmdApi() {
  const [method = 'GET', path = '/api/meta', body] = positional;
  await startServer();
  if (!flags['no-seed']) await seed();
  const r = await api(method.toUpperCase(), path, body ? JSON.parse(body) : undefined);
  console.log(r.status, JSON.stringify(r.body, null, 2));
}

const COMMANDS = { serve: cmdServe, shot: cmdShot, smoke: cmdSmoke, eval: cmdEval, api: cmdApi };

function cleanup() {
  // Only ever the browser this driver launched. Never pkill chrome — that takes
  // the user's own browser with it.
  if (browser) browser.process()?.kill('SIGKILL');
  if (server) server.kill('SIGKILL');
  if (!flags.keep && !flags.db) rmSync(SCRATCH, { recursive: true, force: true });
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

const run = COMMANDS[cmd];
if (!run) {
  console.log(`usage: driver.mjs <${Object.keys(COMMANDS).join('|')}> [options]

  shot   [--out FILE] [--url PATH] [--selector CSS] [--click CSS] [--full] [--desktop]
  smoke                                        add a book through the UI and verify
  eval   '<javascript>'                        evaluate in the page, print JSON
  api    METHOD PATH ['<json>']                call the REST API
  serve                                        keep it running for a human

  --desktop   1280x900 instead of the default 412x870 phone viewport
  --no-seed   skip the demo data
  --db PATH   use this database instead of a scratch one (it is written to)
  --port N    default ${PORT};  --base PATH   mount point, default ${BASE_PATH}
  --keep      leave the scratch database behind;  --verbose  show server output
  --online    let lookups reach the real Open Library / Google Books`);
  process.exit(cmd === 'help' ? 0 : 1);
}
try {
  await run();
} catch (err) {
  console.error(`${cmd} failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
