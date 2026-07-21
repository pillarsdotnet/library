// Browser regression tests for the barcode scanner, driven with a fake camera.
//
// Guards against the Android crash where Html5Qrcode.start() was called with a
// multi-key camera config ("'cameraIdOrConfig' object should have exactly 1
// key ... found 4 keys"), plus general "the camera actually starts" coverage on
// both engines (html5-qrcode native path and the Quagga fallback).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}/library`;
const DB_PATH = `/tmp/home-library-test-${process.pid}.db`;

function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}
const CHROME = findChrome();
// Skip locally when no browser is installed, but never let CI pass without running.
const skip = CHROME ? false : (process.env.CI ? false : 'no Chrome/Chromium found');

let server;
let browser;

test.before(async () => {
  if (!CHROME && process.env.CI) {
    throw new Error('No Chrome/Chromium found in CI — cannot run scanner regression tests');
  }
  if (!CHROME) return;

  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), BASE_PATH: '/library', DB_PATH },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/meta`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not become ready');
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream', // synthetic camera
      '--use-fake-ui-for-media-stream',     // auto-grant permission
    ],
  });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.kill('SIGKILL');
  try { rmSync(DB_PATH, { force: true }); rmSync(`${DB_PATH}-shm`, { force: true }); rmSync(`${DB_PATH}-wal`, { force: true }); } catch { /* ignore */ }
});

// Open the Add-book dialog, tap Scan, and report what happened.
async function driveScan(page) {
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  await page.click('#scanBtn');
  await new Promise((r) => setTimeout(r, 3000));
  const video = await page.evaluate(() => {
    const v = document.querySelector('#scanner video');
    return v ? { present: true, w: v.videoWidth, ready: v.readyState } : { present: false };
  });
  const button = await page.$eval('#scanBtn', (e) => e.textContent.trim());
  return { dialogs, consoleErrors, video, button };
}

test('native (Android/BarcodeDetector) path starts without the "1 key" config crash', { skip }, async () => {
  const page = await browser.newPage();
  // Force the native path by providing a BarcodeDetector before app.js runs.
  await page.evaluateOnNewDocument(() => {
    window.BarcodeDetector = class {
      static getSupportedFormats() { return Promise.resolve(['ean_13', 'ean_8', 'upc_a', 'upc_e']); }
      constructor() {}
      async detect() { return []; }
    };
  });
  const { dialogs, video, button } = await driveScan(page);
  const configErr = dialogs.find((d) => /1 key|cameraIdOrConfig/i.test(d));
  assert.equal(configErr, undefined, `scanner raised html5-qrcode config error: ${configErr}`);
  assert.ok(video.present && video.w > 0 && video.ready >= 2, `camera did not start (video=${JSON.stringify(video)}, dialogs=${dialogs.join(' | ')})`);
  assert.match(button, /Stop/);
  await page.close();
});

test('Quagga (iOS/no-BarcodeDetector) fallback path starts the camera', { skip }, async () => {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { delete window.BarcodeDetector; });
  const { dialogs, video, button } = await driveScan(page);
  assert.deepEqual(dialogs, [], `unexpected error dialog(s): ${dialogs.join(' | ')}`);
  assert.ok(video.present && video.w > 0, `Quagga camera did not start (video=${JSON.stringify(video)})`);
  assert.match(button, /Stop/);
  await page.close();
});

const metaCount = async () => (await (await fetch(`${BASE}/api/meta`)).json()).count;

test('every source value the app writes is selectable and survives an edit', { skip }, async () => {
  // Sources the app itself stores: lookups, the EPUB importer, the Kindle import.
  const sources = ['openlibrary', 'googlebooks', 'barnesnoble', 'bookofthemonth', 'epub', 'kindle', 'manual'];
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });

  const options = await page.$$eval('#bookForm [name="source"] option', (els) => els.map((o) => o.value));
  for (const s of sources) assert.ok(options.includes(s), `source "${s}" must be offered by the dropdown`);

  for (const s of sources) {
    const bk = await (await fetch(`${BASE}/api/books`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Src ${s} ${Date.now()}`, source: s }),
    })).json();
    await page.evaluate(async (id) => {
      const r = await fetch('api/books/' + id);
      window.openEditBook(await r.json());
    }, bk.id);
    await page.waitForSelector('#editDialog[open]');
    assert.equal(await page.$eval('#bookForm [name="source"]', (el) => el.value), s, `form shows the stored source "${s}"`);
    await page.click('#bookForm button[type="submit"]');
    await new Promise((r) => setTimeout(r, 350));
    const after = await (await fetch(`${BASE}/api/books/${bk.id}`)).json();
    assert.equal(after.source, s, `source "${s}" survives an edit`);
  }
  await page.close();
});

test('scanning a duplicate ISBN opens the choice dialog immediately (not only on save)', { skip }, async () => {
  const isbn = '9781783751068';
  const seed = await (await fetch(`${BASE}/api/books`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Foskett Original', isbn }),
  })).json();

  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  // Drive the scan path: acceptScan() sets the ISBN then calls lookup(true).
  await page.evaluate((v) => { document.querySelector("#isbn").value = v; window.lookup(true); }, isbn);

  // The dialog must appear from the scan alone — no Save required.
  await page.waitForSelector('#dupDialog[open]', { timeout: 15000 });
  const optCount = await page.$$eval('#dupOptions .dup-option', (els) => els.length);
  assert.equal(optCount, 2, 'one option for the existing copy plus the "new" option');
  assert.match(await page.$eval('#dupOptions .dup-option strong', (el) => el.textContent), /Foskett Original/);

  // Choosing the existing copy opens it for editing.
  await page.click('#dupOptions .dup-option');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await page.$eval('#dialogTitle', (el) => el.textContent), 'Edit book');
  assert.equal(await page.$eval('#bookForm [name="title"]', (el) => el.value), 'Foskett Original');
  await page.close();

  // And the "new" option creates a record and opens that for editing.
  const before = (await (await fetch(`${BASE}/api/meta`)).json()).count;
  const p2 = await browser.newPage();
  await p2.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await p2.click('#addBtn');
  await p2.waitForSelector('#editDialog[open]');
  // Title first — once the modal duplicate dialog opens, the form behind it is inert.
  await p2.type('#bookForm [name="title"]', 'Foskett Second Copy');
  await p2.evaluate((v) => { document.querySelector('#isbn').value = v; window.lookup(true); }, isbn);
  await p2.waitForSelector('#dupDialog[open]', { timeout: 15000 });
  await p2.click('#dupOptions .dup-option.new');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal((await (await fetch(`${BASE}/api/meta`)).json()).count, before + 1, 'new copy created');
  assert.equal(await p2.$eval('#dialogTitle', (el) => el.textContent), 'Edit book', 'opened for editing');
  assert.notEqual(await p2.$eval('#bookForm [name="title"]', (el) => el.value), 'Foskett Original');
  await p2.close();
  assert.ok(seed.id, 'seed book exists');
});

test('duplicate ISBN prompt: Cancel keeps the record, Edit opens the original', { skip }, async () => {
  const isbn = '9780316158541';
  await fetch(`${BASE}/api/books`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Dup Seed', isbn }),
  });
  const seeded = await metaCount();

  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  await page.type('#bookForm [name="title"]', 'Dup Attempt');
  await page.type('#isbn', isbn);

  // Save → the three-way duplicate dialog appears.
  await page.click('#bookForm button[type="submit"]');
  await page.waitForSelector('#dupDialog[open]', { timeout: 4000 });
  assert.match(await page.$eval('#dupDialogMsg', (el) => el.textContent), /already in your library/i);
  // Existing option shows format + location.
  assert.match(await page.$eval('#dupOptions .dup-option span', (el) => el.textContent), /Unshelved/);

  // Cancel → nothing created, add dialog still open.
  await page.click('#dupCancelBtn');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await metaCount(), seeded, 'Cancel must not create a copy');
  assert.ok(await page.$('#editDialog[open]'), 'add dialog stays open after Cancel');

  // Save again → clicking the existing option loads that record for editing.
  await page.click('#bookForm button[type="submit"]');
  await page.waitForSelector('#dupDialog[open]', { timeout: 4000 });
  await page.click('#dupOptions .dup-option'); // first = the existing book
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.$eval('#dialogTitle', (el) => el.textContent), 'Edit book');
  assert.equal(await page.$eval('#bookForm [name="title"]', (el) => el.value), 'Dup Seed', 'opens the original');
  assert.equal(await metaCount(), seeded, 'editing an existing copy must not create one');
  await page.close();
});

test('duplicate ISBN prompt: the "new" option creates the copy and opens it for editing', { skip }, async () => {
  const isbn = '9780316158541'; // already seeded by the previous test
  const before = await metaCount();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  await page.type('#bookForm [name="title"]', 'Second Copy');
  await page.type('#isbn', isbn);
  await page.click('#bookForm button[type="submit"]');
  await page.waitForSelector('#dupDialog[open]', { timeout: 4000 });

  await page.click('#dupOptions .dup-option.new');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await metaCount(), before + 1, 'the new option creates the copy');
  assert.equal(await page.$eval('#dialogTitle', (el) => el.textContent), 'Edit book', 'opens the new copy for editing');
  assert.equal(await page.$eval('#bookForm [name="title"]', (el) => el.value), 'Second Copy');
  await page.close();
});

test('genres field: comma/Enter commit existing genres as chips; stored as genre_ids', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  await page.type('#bookForm [name="title"]', 'Multi Genre Book');

  const genreInput = '#genreInput';
  // Existing genre committed with a comma.
  await page.type(genreInput, 'Mystery,');
  await new Promise((r) => setTimeout(r, 150));
  // Existing genre committed with Enter.
  await page.type(genreInput, 'Horror');
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 150));
  // A brand-new genre triggers the definition prompt (leave it top-level).
  const newG = 'Weird ' + Date.now();
  await page.type(genreInput, newG);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#newGenreDialog[open]', { timeout: 4000 });
  await page.type('#newGenreDefinition', 'A new kind.');
  await page.click('#newGenreSave');
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(await page.$$eval('#genreField .chip', (els) => els.length), 3, 'three chips committed');

  // Save; the book stores genre_ids referencing the genres table.
  await page.click('#bookForm button[type="submit"]');
  await new Promise((r) => setTimeout(r, 500));
  const books = await (await fetch(`${BASE}/api/books?q=Multi Genre Book`)).json();
  const saved = books.find((b) => b.title === 'Multi Genre Book');
  const names = saved.genres.map((g) => g.name).sort();
  assert.deepEqual(names, ['Horror', 'Mystery', newG].sort());
  assert.equal(saved.genre_ids.length, 3, 'three genre_ids');
  // Filtering by one of its genre ids returns this book.
  const gid = saved.genres.find((g) => g.name === 'Mystery').id;
  const filtered = await (await fetch(`${BASE}/api/books?genre_id=${gid}`)).json();
  assert.ok(filtered.some((b) => b.id === saved.id), 'genre_id filter matches');
  await page.close();
});

test('genres field shows a suggestion dropdown, anchored below the field, and click adds a chip', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  await page.type('#genreInput', 'Magic', { delay: 30 });
  await new Promise((r) => setTimeout(r, 250));
  const info = await page.evaluate(() => {
    const field = document.querySelector('#genreField');
    const list = field.closest('label').querySelector('.combo-list');
    const fr = field.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    return {
      hidden: list.hidden,
      items: [...list.children].map((li) => li.textContent),
      belowField: lr.top >= fr.bottom - 3 && lr.width > 0,
    };
  });
  assert.equal(info.hidden, false, 'dropdown visible while typing');
  assert.ok(info.items.some((i) => i.includes('Magical')), 'suggests matching genres (Realism › Magical)');
  assert.ok(info.belowField, 'dropdown is positioned below the field');
  await page.click('.combo-list li');
  await new Promise((r) => setTimeout(r, 150));
  const chips = await page.$$eval('#genreField .chip', (els) => els.map((e) => e.textContent.replace('✕', '').trim()));
  assert.ok(chips.length === 1, 'clicking a suggestion adds a chip');
  await page.close();
});

test('leaving the genres field commits pending text (prompts for a new genre) but trims punctuation-only', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');

  // Unmatched word + blur → definition prompt → chip.
  const newG = 'Technical ' + Date.now();
  await page.type('#genreInput', newG);
  await page.focus('#bookForm [name="title"]');
  await page.waitForSelector('#newGenreDialog[open]', { timeout: 4000 });
  await page.type('#newGenreDefinition', 'Technical works.');
  await page.click('#newGenreSave');
  await new Promise((r) => setTimeout(r, 300));
  let chips = await page.$$eval('#genreField .chip', (els) => els.map((e) => e.textContent.replace('✕', '').trim()));
  assert.ok(chips.includes(newG), 'blur committed the unmatched word');

  // Punctuation/space only + blur → no prompt, input trimmed to empty.
  await page.focus('#genreInput');
  await page.type('#genreInput', '  .. ');
  await page.focus('#bookForm [name="title"]');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await page.$eval('#newGenreDialog', (el) => el.open).catch(() => false), false, 'no prompt for punctuation-only');
  assert.equal(await page.$eval('#genreInput', (e) => e.value), '', 'punctuation/space trimmed away');
  chips = await page.$$eval('#genreField .chip', (els) => els.length);
  assert.equal(chips, 1, 'no stray chip added');
  await page.close();
});

test('genres field commits a new genre from a typed comma via the input event (mobile keyboards)', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  // Mobile virtual keyboards deliver the comma via the input event, not a
  // keydown with e.key === ',' — simulate that exactly.
  const newG = 'Nonfiction ' + Date.now();
  await page.evaluate((val) => {
    const el = document.querySelector('#genreInput');
    el.focus();
    el.value = val + ',';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, newG);
  await page.waitForSelector('#newGenreDialog[open]', { timeout: 4000 });
  await page.type('#newGenreDefinition', 'Not fiction.');
  await page.click('#newGenreSave');
  await new Promise((r) => setTimeout(r, 400));
  const chips = await page.$$eval('#genreField .chip', (els) => els.map((e) => e.textContent.replace('✕', '').trim()));
  assert.ok(chips.includes(newG), 'comma typed via input event committed the new genre');
  await page.close();
});

test('reader-level (Maturity) genres are seeded as subgenres of Maturity', { skip }, async () => {
  const genres = await (await fetch(`${BASE}/api/genres`)).json();
  const maturity = genres.find((x) => x.name === 'Maturity' && !x.parent_id);
  assert.ok(maturity, 'Maturity top-level seeded');
  for (const name of ['Adult', 'Child', 'Middle-Grade', 'Young-Adult']) {
    const g = genres.find((x) => x.name === name && x.parent_id === maturity.id);
    assert.ok(g, `Maturity›${name} seeded`);
    assert.ok(g.definition, `Maturity›${name} has a definition`);
  }
});

test('typing a new genre in the book form prompts for a definition and saves it', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  await page.type('#bookForm [name="title"]', 'Genre Prompt Book');
  const newGenre = 'Steampunk ' + Date.now();
  await page.type('#genreInput', newGenre);
  await page.click('#bookForm button[type="submit"]');

  // New-genre definition dialog should appear (commitPending on save).
  await page.waitForSelector('#newGenreDialog[open]', { timeout: 4000 });
  assert.match(await page.$eval('#newGenrePrompt', (el) => el.textContent), /is new/i);
  await page.type('#newGenreDefinition', 'Gears and steam.');
  await page.click('#newGenreSave');
  await new Promise((r) => setTimeout(r, 600));

  // The genre now exists in the taxonomy with its definition.
  const genres = await (await fetch(`${BASE}/api/genres`)).json();
  const created = genres.find((g) => g.name === newGenre);
  assert.ok(created, 'new genre was created');
  assert.equal(created.definition, 'Gears and steam.');
  assert.equal(created.parent_id, null);
  await page.close();
});

test('book list paginates and serves inline covers from their own endpoint', { skip }, async () => {
  const stamp = String(Date.now()).slice(-6);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const mk = (body) => fetch(`${BASE}/api/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (let i = 0; i < 22; i++) await mk({ title: `Pg${stamp} ${String(i).padStart(2, '0')}` });
  const withCover = await (await mk({ title: `Pg${stamp} cover`, cover_url: png })).json();

  // Inline covers are returned as a reference, not embedded. The reference is
  // versioned so a replacement photo cannot be masked by a cached copy — see
  // test/cover.test.mjs.
  assert.match(withCover.cover_url, new RegExp(`^api/books/${withCover.id}/cover\\?v=`), 'data: cover replaced by a versioned reference');
  const img = await fetch(`${BASE}/api/books/${withCover.id}/cover`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /^image\/png/);
  assert.ok((await img.arrayBuffer()).byteLength > 0, 'cover endpoint returns image bytes');

  // Echoing the reference back on save must not destroy the stored image.
  await fetch(`${BASE}/api/books/${withCover.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Pg${stamp} cover`, cover_url: `api/books/${withCover.id}/cover` }),
  });
  assert.equal((await fetch(`${BASE}/api/books/${withCover.id}/cover`)).status, 200, 'cover survives a save');

  // Pagination: default page, total header, offset, and limit=0 for everything.
  const r1 = await fetch(`${BASE}/api/books?q=Pg${stamp}`);
  const p1 = await r1.json();
  const total = Number(r1.headers.get('X-Total-Count'));
  assert.equal(p1.length, 20, 'default page size is 20');
  assert.equal(total, 23, 'X-Total-Count reports the full match count');
  const p2 = await (await fetch(`${BASE}/api/books?q=Pg${stamp}&limit=20&offset=20`)).json();
  assert.equal(p2.length, 3, 'second page holds the remainder');
  assert.equal(new Set([...p1, ...p2].map((b) => b.id)).size, 23, 'pages do not overlap');
  const all = await (await fetch(`${BASE}/api/books?q=Pg${stamp}&limit=0`)).json();
  assert.equal(all.length, 23, 'limit=0 returns everything');

  // UI shows one page plus a working "Load more".
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.type('#search', `Pg${stamp}`);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(await page.$$eval('#list .card', (e) => e.length), 20, 'first page rendered');
  assert.match(await page.$eval('#pagerCount', (e) => e.textContent), /Showing 20 of 23/);
  await page.click('#loadMoreBtn');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await page.$$eval('#list .card', (e) => e.length), 23, 'load more appended the rest');
  assert.equal(await page.$eval('#loadMoreBtn', (e) => e.hidden), true, 'load more hides at the end');

  // Changing a filter replaces the list rather than appending to it.
  await page.select('#filterFormat', 'audiobook');
  await new Promise((r) => setTimeout(r, 600));
  const after = await page.$$eval('#list .card', (e) => e.length);
  assert.ok(after < 23, `filter change replaced the list (got ${after} cards)`);
  await page.close();
});

test('series field: new entry creates the series and the position field sets the number', { skip }, async () => {
  const seriesTitle = 'Test Series ' + Date.now();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });

  const addBook = async (title, order) => {
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await page.type('#bookForm [name="title"]', title);
    await page.type('#seriesInput', seriesTitle);
    await page.click('#bookForm [name="authors"]');          // blur commits the series box
    await new Promise((r) => setTimeout(r, 400));            // series created, position defaulted
    await page.$eval('#seriesPosition', (el, v) => { el.value = v; }, String(order));
    await page.click('#bookForm button[type="submit"]');
    await new Promise((r) => setTimeout(r, 500));
  };

  await addBook('S One', 1);
  await addBook('S Two', 2);
  await addBook('S Three', 3);

  const all = await (await fetch(`${BASE}/api/series`)).json();
  const s = all.find((x) => x.title === seriesTitle);
  assert.ok(s, 'series created from the book form');
  let books = await (await fetch(`${BASE}/api/series/${s.id}/books`)).json();
  assert.deepEqual(books.map((b) => `${b.order}:${b.title}`), ['1:S One', '2:S Two', '3:S Three']);

  // A second edition of book 2 shares the number instead of bumping anything.
  await addBook('S Two ebook', 2);
  books = await (await fetch(`${BASE}/api/series/${s.id}/books`)).json();
  assert.deepEqual(books.map((b) => `${b.order}:${b.title}`), ['1:S One', '2:S Two', '2:S Two ebook', '3:S Three']);
  await page.close();
});

// A "book cover photographed at an angle": light skewed quad on a dark surface.
const SKEW_CORNERS = [[150, 80], [640, 140], [600, 520], [110, 470]];
async function skewedCoverJpeg() {
  const pts = SKEW_CORNERS.map((p) => p.join(',')).join(' ');
  // Printed, not blank: a real cover carries lettering and a picture, and the
  // detector leans on that to tell a cover from the surface under it.
  const svg = `<svg width="800" height="600">
    <defs><clipPath id="cover"><polygon points="${pts}"/></clipPath></defs>
    <rect width="800" height="600" fill="#3a3a3a"/>
    <polygon points="${pts}" fill="#efe9dd"/>
    <g clip-path="url(#cover)">
      <rect x="170" y="110" width="440" height="60" fill="#2f4858"/>
      <rect x="170" y="200" width="400" height="130" fill="#c96f4a"/>
      <rect x="170" y="350" width="380" height="90" fill="#4a6b4f"/>
      <rect x="170" y="450" width="300" height="40" fill="#2f4858"/>
    </g>
    <polygon points="${pts}" fill="none" stroke="#c9bfa8" stroke-width="6"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

// The real failure this was reported for: a book photographed lying on a paper
// bag. The bag is the bigger, sharper rectangle, so a naive detector crops to
// the bag; brown bag and coloured cover can also match in brightness, so the
// boundary is invisible to a luminance-only pass. Cover art here is coloured
// blocks and lettering, at the same brightness as the bag around it.
const BOOK_BOX = { x: 190, y: 150, w: 320, h: 470 };
async function bookOnBagJpeg() {
  const b = BOOK_BOX;
  const svg = `<svg width="700" height="900">
    <rect width="700" height="900" fill="#b59a70"/>
    <rect x="60" y="70" width="580" height="760" fill="#b0996f"/>
    <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#7f9a6e"/>
    <rect x="${b.x + 30}" y="${b.y + 40}" width="${b.w - 60}" height="70" fill="#2f4858"/>
    <rect x="${b.x + 30}" y="${b.y + 150}" width="${b.w - 60}" height="180" fill="#c96f4a"/>
    <rect x="${b.x + 30}" y="${b.y + 360}" width="${b.w - 90}" height="40" fill="#2f4858"/>
    <rect x="${b.x + 30}" y="${b.y + 410}" width="${b.w - 120}" height="24" fill="#efe9dd"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

// The same cover, but the art below the title is a big rectangle in its own
// right — a tighter crop that scores beautifully on "busy inside, calm outside"
// and throws the title away. Losing the title is much worse than leaving a
// margin, so the whole cover must win.
async function coverWithInnerPanelJpeg() {
  const b = BOOK_BOX;
  const svg = `<svg width="700" height="900">
    <rect width="700" height="900" fill="#b59a70"/>
    <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#efe9dd"/>
    <rect x="${b.x + 40}" y="${b.y + 30}" width="${b.w - 80}" height="60" fill="#33455c"/>
    <rect x="${b.x + 20}" y="${b.y + 150}" width="${b.w - 40}" height="${b.h - 190}" fill="#4a6b4f"/>
    <rect x="${b.x + 60}" y="${b.y + 200}" width="120" height="150" fill="#c96f4a"/>
    <rect x="${b.x + 70}" y="${b.y + 400}" width="160" height="90" fill="#e3d9c0"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

test('auto-crop finds a skewed cover and flattens it, but declines when there is no rectangle', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });

  const run = async (buf) => page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/jpeg;base64,' + data; });
    const out = window.AutoCrop.autoCrop(img);
    if (!out) return { cropped: false };
    const ctx = out.canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, out.canvas.width, out.canvas.height).data;
    // How much of the result is the dark surface the cover was lying on: that,
    // not "how light is it", is what says the crop landed on the cover.
    let surface = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 58) < 22 && Math.abs(d[i + 1] - 58) < 22 && Math.abs(d[i + 2] - 58) < 22) surface += 1;
    }
    return {
      cropped: true,
      quad: out.quad.map((q) => [Math.round(q.x), Math.round(q.y)]),
      surfaceFraction: surface / (out.canvas.width * out.canvas.height),
    };
  }, buf.toString('base64'));

  const skew = await run(await skewedCoverJpeg());
  assert.equal(skew.cropped, true, 'the skewed cover is detected');
  skew.quad.forEach(([x, y], i) => {
    const [tx, ty] = SKEW_CORNERS[i];
    assert.ok(Math.hypot(x - tx, y - ty) < 20, `corner ${i} near truth: got ${x},${y} want ${tx},${ty}`);
  });
  assert.ok(skew.surfaceFraction < 0.05, `flattened result is the cover, not the surface (${skew.surfaceFraction})`);

  // Must NOT fire on images with no croppable rectangle — a false positive would
  // mangle the photo, which is worse than doing nothing.
  const fullFrame = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#e8e2d6' } }).jpeg().toBuffer();
  const flat = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#777777' } }).jpeg().toBuffer();
  assert.equal((await run(fullFrame)).cropped, false, 'an already-cropped cover is left alone');
  assert.equal((await run(flat)).cropped, false, 'a textureless photo is left alone');

  // Crop to the book, not to the bag it is lying on, and not to a block of its
  // own cover art.
  const bag = await run(await bookOnBagJpeg());
  assert.equal(bag.cropped, true, 'the book on the bag is detected');
  const want = [
    [BOOK_BOX.x, BOOK_BOX.y], [BOOK_BOX.x + BOOK_BOX.w, BOOK_BOX.y],
    [BOOK_BOX.x + BOOK_BOX.w, BOOK_BOX.y + BOOK_BOX.h], [BOOK_BOX.x, BOOK_BOX.y + BOOK_BOX.h],
  ];
  bag.quad.forEach(([x, y], i) => {
    assert.ok(Math.hypot(x - want[i][0], y - want[i][1]) < 25,
      `corner ${i} is the book's, not the bag's: got ${x},${y} want ${want[i]}`);
  });

  // ...and take the whole cover, not the picture panel inside it. The tolerance
  // is looser here because a side can settle on a printed band a little inside
  // the true edge: a small margin lost is acceptable, a lost title is not, so
  // what is really being checked is that the full width and the title survive.
  const panel = await run(await coverWithInnerPanelJpeg());
  assert.equal(panel.cropped, true, 'the cover is detected');
  panel.quad.forEach(([x, y], i) => {
    assert.ok(Math.hypot(x - want[i][0], y - want[i][1]) < 35,
      `corner ${i} is the cover's, not the inner panel's: got ${x},${y} want ${want[i]}`);
  });
  const [tl, tr] = panel.quad;
  assert.ok(tr[0] - tl[0] > BOOK_BOX.w * 0.9, `full cover width kept (${tr[0] - tl[0]} of ${BOOK_BOX.w})`);
  assert.ok(tl[1] < BOOK_BOX.y + 30, `crop starts above the title (${tl[1]}, title at ${BOOK_BOX.y + 30})`);
  await page.close();
});

test('the cover dialog offers auto-crop without applying it, and applies it on request', { skip }, async () => {
  const file = join(ROOT, 'test', `tmp-skewed-${process.pid}.jpg`);
  writeFileSync(file, await skewedCoverJpeg());
  try {
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await (await page.$('#coverUploadFile')).uploadFile(file);
    await page.waitForSelector('#cropDialog[open]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 600));

    // The photo as taken is what opens: an unrequested crop that guesses wrong
    // takes the title off the cover, so nothing is applied until it is asked for.
    assert.equal(await page.$eval('#autoCropToggle', (el) => el.hidden), false, 'auto-crop offered');
    assert.match(await page.$eval('#autoCropMsg', (el) => el.textContent), /auto-crop to straighten/i);
    assert.match(await page.$eval('#cropImage', (el) => el.src), /^blob:/, 'cropper opens on the original photo');

    await page.click('#autoCropToggle');
    await new Promise((r) => setTimeout(r, 400));
    assert.match(await page.$eval('#cropImage', (el) => el.src), /^data:image/, 'now showing the flattened image');
    assert.match(await page.$eval('#autoCropMsg', (el) => el.textContent), /straightened/i);

    await page.click('#autoCropToggle');       // back to the photo
    await new Promise((r) => setTimeout(r, 400));
    assert.match(await page.$eval('#cropImage', (el) => el.src), /^blob:/, 'toggled back to the original');

    await page.click('#autoCropToggle');       // and forward again
    await new Promise((r) => setTimeout(r, 400));
    await page.click('#cropUse');
    await new Promise((r) => setTimeout(r, 400));
    assert.match(await page.$eval('#bookForm [name="cover_url"]', (el) => el.value), /^data:image\/jpeg/, 'cover accepted');
    await page.close();
  } finally {
    rmSync(file, { force: true });
  }
});

// Guards the invariant, not a reproduction: the reported black frame came from
// a phone, whose crop dialog is laid out differently, and it does not appear in
// a headless window at any viewport tried. What is checked here is what must
// hold everywhere — the crop box never covers ground the photo does not, and
// nothing black is ever baked into a saved cover.
test('a saved cover never gains a black frame, however the photo is zoomed', { skip }, async () => {
  const file = join(ROOT, 'test', `tmp-zoom-${process.pid}.jpg`);
  writeFileSync(file, await skewedCoverJpeg());
  try {
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await (await page.$('#coverUploadFile')).uploadFile(file);
    await page.waitForSelector('#cropDialog[open]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 600));

    const fits = () => page.evaluate(() => {
      const c = document.querySelector('#cropImage').cropper;
      const canvas = c.getCanvasData(), box = c.getCropBoxData();
      return box.width <= canvas.width + 1 && box.height <= canvas.height + 1;
    });
    assert.ok(await fits(), 'crop box starts within the photo');
    await page.click('#autoCropToggle');   // swaps in a differently-shaped image
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(await fits(), 'crop box still within the photo after the toggle');

    // Zoom the photo down. Any part of the crop box the photo no longer covers
    // is transparent, and a JPEG writes transparent out as black — that is how
    // covers came back framed in black.
    await page.evaluate(() => document.querySelector('#cropImage').cropper.zoom(-0.5));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(await fits(), 'crop box still within the photo after zooming out');
    await page.click('#cropUse');
    await new Promise((r) => setTimeout(r, 500));

    const url = await page.$eval('#bookForm [name="cover_url"]', (el) => el.value);
    assert.match(url, /^data:image\/jpeg/, 'cover accepted');
    const border = await page.evaluate(async (src) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const at = (x, y) => { const i = (y * c.width + x) * 4; return d[i] + d[i + 1] + d[i + 2]; };
      let dark = 0, n = 0;
      for (let x = 0; x < c.width; x += 1) {
        for (const y of [0, 1, c.height - 2, c.height - 1]) { if (at(x, y) < 60) dark += 1; n += 1; }
      }
      for (let y = 0; y < c.height; y += 1) {
        for (const x of [0, 1, c.width - 2, c.width - 1]) { if (at(x, y) < 60) dark += 1; n += 1; }
      }
      return dark / n;
    }, url);
    assert.ok(border < 0.02, `saved cover has no black frame (${Math.round(border * 100)}% of its border is black)`);
    await page.close();
  } finally {
    rmSync(file, { force: true });
  }
});

test('picking genre suggestions never removes already-chosen genres, but ✕ still does', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  const chips = () => page.$$eval('#genreField .chip', (els) => els.map((c) => c.textContent.replace('✕', '').trim()));

  // Tap each suggestion the way a finger does: pointerdown, then a click at the
  // same coordinates. Acting on pointerdown used to reflow the field so that the
  // follow-up click hit an existing chip's ✕ and silently dropped a genre.
  const terms = ['Adult', 'Magical', 'Earth', 'Historical'];
  for (const [i, term] of terms.entries()) {
    await page.click('#genreInput', { clickCount: 3 });
    await page.type('#genreInput', term, { delay: 10 });
    await new Promise((r) => setTimeout(r, 250));
    const li = await page.$('.combo-list li');
    assert.ok(li, `expected a suggestion for "${term}"`);
    const box = await li.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal((await chips()).length, i + 1, `picking "${term}" should only ever add a chip`);
  }
  const before = await chips();
  assert.equal(before.length, 4, 'all four genres retained');

  // The ✕ must still remove a chip on a deliberate click (past the ghost-click guard).
  await new Promise((r) => setTimeout(r, 500));
  await page.click('#genreField .chip button');
  await new Promise((r) => setTimeout(r, 200));
  const after = await chips();
  assert.equal(after.length, 3, '✕ still removes a chip');
  assert.ok(!after.includes(before[0]), 'the clicked chip is the one removed');
  await page.close();
});

test('series position is editable when editing a book', { skip }, async () => {
  const stamp = String(Date.now()).slice(-6);
  const post = async (p, body) => (await fetch(`${BASE}/api/${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const s = await post('series', { title: `Editable ${stamp}` });
  const bk = await post('books', { title: `EditPos ${stamp}` });
  await post(`series/${s.id}/books`, { book_id: bk.id, order: 2 });

  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(async (id) => {
    const r = await fetch('api/books/' + id);
    window.openEditBook(await r.json());
  }, bk.id);
  await page.waitForSelector('#editDialog[open]');

  // The current series and position are shown, both editable.
  assert.equal(await page.$eval('#seriesInput', (el) => el.value), `Editable ${stamp}`);
  assert.equal(await page.$eval('#seriesPosition', (el) => el.value), '2', 'current position shown');

  // Change just the position and save.
  await page.$eval('#seriesPosition', (el) => { el.value = '5'; });
  await page.click('#bookForm button[type="submit"]');
  await new Promise((r) => setTimeout(r, 600));
  const after = await (await fetch(`${BASE}/api/books/${bk.id}`)).json();
  assert.equal(after.series.order, 5, 'edited position saved');
  assert.equal(after.series.title, `Editable ${stamp}`, 'still in the same series');
  await page.close();
});

test('Shelves tab nests shelves by room → bookcase → shelf, each sorted', { skip }, async () => {
  const stamp = String(Date.now()).slice(-6);
  const mk = (room, bookcase, label) => fetch(`${BASE}/api/shelves`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, bookcase, label }),
  });
  // Insert out of order to prove sorting.
  await mk(`Zroom${stamp}`, 'Pine', 'Top');
  await mk(`Aroom${stamp}`, 'Oak', '2L');
  await mk(`Aroom${stamp}`, 'Oak', '1L');
  await mk(`Aroom${stamp}`, 'Birch', 'Only');

  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('.tab[data-tab="shelves"]');
  await page.waitForSelector('#tab-shelves:not([hidden])');
  const tree = await page.evaluate(() => [...document.querySelectorAll('.room-group')].map((rg) => ({
    room: rg.querySelector('.room-heading').firstChild.textContent.trim(),
    count: rg.querySelector('.room-heading .group-count').textContent.trim(),
    bookcases: [...rg.querySelectorAll('.bookcase-group')].map((bc) => ({
      bookcase: bc.querySelector('.bookcase-heading').firstChild.textContent.trim(),
      count: bc.querySelector('.bookcase-heading .group-count').textContent.trim(),
      shelves: [...bc.querySelectorAll('.shelf-card h3')].map((h) => h.textContent.trim()),
    })),
  })));

  const aRoom = tree.find((r) => r.room === `Aroom${stamp}`);
  assert.ok(aRoom, 'room group rendered');
  assert.deepEqual(aRoom.bookcases.map((b) => b.bookcase), ['Birch', 'Oak'], 'bookcases sorted within room');
  assert.deepEqual(aRoom.bookcases.find((b) => b.bookcase === 'Oak').shelves, ['1L', '2L'], 'shelves sorted within bookcase');

  // "shelf" pluralises to "shelves", never "shelfves".
  assert.match(aRoom.count, /^3 shelves$/, 'room count');
  assert.match(aRoom.bookcases.find((b) => b.bookcase === 'Oak').count, /^2 shelves\b/, 'plural bookcase count');
  assert.match(aRoom.bookcases.find((b) => b.bookcase === 'Birch').count, /^1 shelf\b/, 'singular bookcase count');
  const headings = await page.$$eval('.group-count', (els) => els.map((e) => e.textContent));
  assert.equal(headings.filter((t) => /shelfves|shelfs/.test(t)).length, 0, 'no mangled plurals anywhere');

  // Rooms themselves are in sorted order.
  const rooms = tree.map((r) => r.room);
  assert.deepEqual([...rooms].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), rooms, 'rooms sorted');
  await page.close();
});

test('deleting a genre warns with the book count and removes the book_genres links', { skip }, async () => {
  const stamp = Date.now();
  const genre = await (await fetch(`${BASE}/api/genres`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'DelGenre ' + stamp, definition: 'x' }) })).json();
  const book = await (await fetch(`${BASE}/api/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'DelBook ' + stamp, genre_ids: [genre.id] }) })).json();

  const page = await browser.newPage();
  let dialogMsg = '';
  page.on('dialog', async (d) => { dialogMsg = d.message(); await d.accept(); }); // confirm the delete
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('.tab[data-tab="genres"]');
  await page.waitForSelector('#tab-genres:not([hidden])');
  await page.click(`[data-edit-genre="${genre.id}"]`);
  await page.waitForSelector('#genreDialog[open]');
  await page.click('#deleteGenreBtn');
  await new Promise((r) => setTimeout(r, 400));

  assert.match(dialogMsg, /1 book classified under it/i, `warning should state the book count (got: ${dialogMsg})`);
  // Genre gone, and the book's genre link removed (book itself remains).
  const genres = await (await fetch(`${BASE}/api/genres`)).json();
  assert.ok(!genres.some((g) => g.id === genre.id), 'genre deleted');
  const after = await (await fetch(`${BASE}/api/books/${book.id}`)).json();
  assert.deepEqual(after.genre_ids, [], 'book_genres link removed');
  assert.equal(after.title, book.title, 'book itself preserved');
  await page.close();
});

test('series filter narrows the list, orders by series position, and finds standalones', { skip }, async () => {
  const stamp = String(Date.now()).slice(-6);
  const post = async (p, body) => (await fetch(`${BASE}/api/${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const s = await post('series', { title: `Filter Series ${stamp}` });
  // Deliberately not in alphabetical order, to prove sorting is by series position.
  for (const [title, order] of [[`Zeta ${stamp}`, 1], [`Alpha ${stamp}`, 2], [`Mu ${stamp}`, 3]]) {
    const b = await post('books', { title });
    await post(`series/${s.id}/books`, { book_id: b.id, order });
  }
  const solo = await post('books', { title: `Solo ${stamp}` });

  const inSeries = await (await fetch(`${BASE}/api/books?series_id=${s.id}`)).json();
  assert.deepEqual(inSeries.map((b) => b.title), [`Zeta ${stamp}`, `Alpha ${stamp}`, `Mu ${stamp}`], 'ordered by series position');
  const standalone = await (await fetch(`${BASE}/api/books?series_id=none&q=Solo ${stamp}`)).json();
  assert.deepEqual(standalone.map((b) => b.id), [solo.id], '"Not in a series" finds standalone books');

  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  const opts = await page.$$eval('#filterSeries option', (els) => els.map((o) => o.textContent));
  assert.ok(opts.some((o) => o.includes(`Filter Series ${stamp}`)), 'series listed in the filter');
  assert.ok(opts.some((o) => /not in a series/i.test(o)), '"Not in a series" option present');
  await page.select('#filterSeries', String(s.id));
  await new Promise((r) => setTimeout(r, 600));
  const titles = await page.$$eval('#list .card h3', (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles, [`Zeta ${stamp}`, `Alpha ${stamp}`, `Mu ${stamp}`], 'UI shows the series in order');
  await page.close();
});

test('genre filter has an Uncategorized option that finds books with no genres', { skip }, async () => {
  const stamp = Date.now();
  const g = await (await fetch(`${BASE}/api/genres`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'FilterGenre ' + stamp, definition: 'x' }) })).json();
  await fetch(`${BASE}/api/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'NoGenre ' + stamp }) });
  await fetch(`${BASE}/api/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'HasGenre ' + stamp, genre_ids: [g.id] }) });

  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  const hasOpt = await page.$$eval('#filterGenre option', (els) => els.some((o) => o.value === 'none' && /uncategor/i.test(o.textContent)));
  assert.ok(hasOpt, 'Uncategorized option present in genre filter');
  await page.select('#filterGenre', 'none');
  await new Promise((r) => setTimeout(r, 400));
  const titles = await page.$$eval('#list .card h3', (els) => els.map((e) => e.textContent));
  assert.ok(titles.includes('NoGenre ' + stamp), 'uncategorized book listed');
  assert.ok(!titles.includes('HasGenre ' + stamp), 'categorized book excluded');
  await page.close();
});

test('Genres tab supports multi-level subgenres and reparenting', { skip }, async () => {
  const stamp = Date.now();
  // Build Nonfiction > Technical via the API.
  const non = await (await fetch(`${BASE}/api/genres`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nonfiction ' + stamp, definition: 'x' }) })).json();
  const tech = await (await fetch(`${BASE}/api/genres`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Technical ' + stamp, definition: 'x', parent_id: non.id }) })).json();

  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('.tab[data-tab="genres"]');
  await page.waitForSelector('#tab-genres:not([hidden])');

  // Add-genre parent dropdown offers the 2nd-level "Technical" as a parent (full path label).
  await page.click('#addGenreBtn');
  await page.waitForSelector('#genreDialog[open]');
  const parentLabels = await page.$$eval('#genreParent option', (els) => els.map((e) => e.textContent));
  assert.ok(parentLabels.some((l) => l.includes('›') && l.includes('Technical ' + stamp)), 'parent dropdown lists a subgenre as a possible parent');

  // Create Computer under Technical (3rd level) via the dialog.
  await page.type('#genreForm [name="name"]', 'Computer ' + stamp);
  await page.select('#genreParent', String(tech.id));
  await page.type('#genreForm [name="definition"]', 'computers');
  await page.click('#genreForm button[type="submit"]');
  await new Promise((r) => setTimeout(r, 400));
  let genres = await (await fetch(`${BASE}/api/genres`)).json();
  const comp = genres.find((g) => g.name === 'Computer ' + stamp);
  assert.equal(comp.parent_id, tech.id, 'Computer nested under Technical (3rd level)');

  // Reparent Computer directly under Nonfiction via the edit dialog.
  await page.click(`[data-edit-genre="${comp.id}"]`);
  await page.waitForSelector('#genreDialog[open]');
  assert.equal(await page.$eval('#genreParent', (el) => el.disabled), false, 'parent select is editable');
  await page.select('#genreParent', String(non.id));
  await page.click('#genreForm button[type="submit"]');
  await new Promise((r) => setTimeout(r, 400));
  genres = await (await fetch(`${BASE}/api/genres`)).json();
  assert.equal(genres.find((g) => g.id === comp.id).parent_id, non.id, 'Computer reparented under Nonfiction');
  await page.close();
});

test('Genres tab lists the taxonomy and can edit a definition', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('.tab[data-tab="genres"]');
  await page.waitForSelector('#tab-genres:not([hidden])');
  const rowCount = await page.$$eval('#genreList .genre-row', (els) => els.length);
  assert.ok(rowCount >= 6, `expected the seeded genres, saw ${rowCount}`);

  // Edit Thriller's definition.
  const genres = await (await fetch(`${BASE}/api/genres`)).json();
  const thriller = genres.find((g) => g.name === 'Thriller');
  await page.click(`[data-edit-genre="${thriller.id}"]`);
  await page.waitForSelector('#genreDialog[open]');
  const def = await page.$('#genreForm [name="definition"]');
  await def.click();
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type('#genreForm [name="definition"]', 'Edited via UI.');
  await page.click('#genreForm button[type="submit"]');
  await new Promise((r) => setTimeout(r, 400));
  const after = await (await fetch(`${BASE}/api/genres`)).json();
  assert.equal(after.find((g) => g.id === thriller.id).definition, 'Edited via UI.');
  await page.close();
});

test('Clear filters button resets all filters and is hidden when none are active', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });

  assert.equal(await page.$eval('#clearFiltersBtn', (el) => el.hidden), true, 'hidden with no filters');

  await page.select('#filterFormat', 'ebook');
  await page.type('#search', 'the');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await page.$eval('#clearFiltersBtn', (el) => el.hidden), false, 'shown when a filter is active');

  await page.click('#clearFiltersBtn');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.$eval('#search', (el) => el.value), '', 'search cleared');
  assert.equal(await page.$eval('#filterFormat', (el) => el.value), '', 'format cleared');
  assert.equal(await page.$eval('#clearFiltersBtn', (el) => el.hidden), true, 'hidden again after clearing');
  await page.close();
});

test('EPUB import endpoint: parses metadata, resizes cover, creates an e-book', { skip }, async () => {
  const coverJpeg = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#334455' } }).jpeg().toBuffer();
  const opf = '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="b">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + '<dc:title>Imported Test Book</dc:title><dc:creator>Wells, Martha</dc:creator>'
    + '<dc:identifier>9780765397539</dc:identifier><dc:publisher>Tor</dc:publisher><dc:date>2017</dc:date>'
    + '<meta name="cover" content="c"/></metadata>'
    + '<manifest><item id="c" href="cover.jpg" media-type="image/jpeg"/></manifest></package>';
  const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const epub = zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/cover.jpg': new Uint8Array(coverJpeg),
  });

  const r = await fetch(`${BASE}/api/import/epub`, {
    method: 'POST', headers: { 'Content-Type': 'application/epub+zip' }, body: epub,
  });
  assert.equal(r.status, 201);
  const book = await r.json();
  assert.equal(book.title, 'Imported Test Book');
  assert.equal(book.authors, 'Martha Wells');
  assert.equal(book.isbn, '9780765397539');
  assert.equal(book.format, 'ebook');
  assert.equal(book.source, 'epub');
  assert.match(book.cover_url, /^data:image\/jpeg;base64,/);
});

test('cover photo: file → crop dialog → "Use photo" sets a data-URL cover', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  const input = await page.$('#coverUploadFile');
  await input.uploadFile(join(ROOT, 'test', 'fixtures', 'sample-cover.png'));
  await page.waitForSelector('#cropDialog[open]', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 900)); // let Cropper initialise
  await page.click('#cropUse');
  await new Promise((r) => setTimeout(r, 300));
  const cover = await page.$eval('#bookForm [name="cover_url"]', (el) => el.value);
  assert.match(cover, /^data:image\/jpeg/, 'cover should be a cropped JPEG data URL');
  const previewShown = await page.evaluate(() => {
    const i = document.querySelector('#coverPreview');
    return !!i && !i.hidden;
  });
  assert.ok(previewShown, 'preview should display the cropped cover');
  await page.close();
});

test('corners can be dragged by hand and the result is flattened to them', { skip }, async () => {
  const file = join(ROOT, 'test', `tmp-corners-${process.pid}.jpg`);
  writeFileSync(file, await skewedCoverJpeg());
  try {
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await (await page.$('#coverUploadFile')).uploadFile(file);
    await page.waitForSelector('#cropDialog[open]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 700));

    await page.click('#cornerMode');
    await page.waitForSelector('#cornerArea:not([hidden])');
    await new Promise((r) => setTimeout(r, 300));

    // The editor starts from whatever the detector proposed.
    const start = await page.evaluate(() => window.CornerEditor.corners().map((p) => [Math.round(p.x), Math.round(p.y)]));
    assert.equal(start.length, 4, 'four corners to drag');

    // Drag the top-left marker somewhere new and check it followed the pointer.
    const box = await page.$eval('#cornerCanvas', (c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, w: c.width, h: c.height };
    });
    const scaleX = box.width / box.w, scaleY = box.height / box.h;
    const from = await page.evaluate(() => {
      const c = document.querySelector('#cornerCanvas');
      const p = window.CornerEditor.corners()[0];
      return { x: p.x, y: p.y, cw: c.width, natural: 800 };
    });
    const startX = box.left + (from.x * (from.cw / from.natural)) * scaleX;
    const startY = box.top + (from.y * (from.cw / from.natural)) * scaleY;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY + 25, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 200));

    const moved = await page.evaluate(() => window.CornerEditor.corners().map((p) => [Math.round(p.x), Math.round(p.y)]));
    assert.notDeepEqual(moved[0], start[0], 'the dragged corner moved');
    assert.deepEqual(moved.slice(1), start.slice(1), 'the other corners stayed put');

    // Flattening uses the corners as they now stand.
    await page.click('#cornerApply');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await page.$eval('#cornerArea', (el) => el.hidden), true, 'back to the cropper');
    assert.match(await page.$eval('#autoCropMsg', (el) => el.textContent), /corners you set/i);
    assert.match(await page.$eval('#cropImage', (el) => el.src), /^data:image/, 'showing the flattened result');
    await page.close();
  } finally {
    rmSync(file, { force: true });
  }
});

// The crop dialog opened onto a solid black rectangle: the corner editor's
// overlay still carried its hidden attribute, but .corner-area sets display,
// and any author rule that sets display beats the browser's own [hidden] rule
// however unspecific it is. Checking `el.hidden` cannot catch this — the
// property was true the whole time — so this asks what the eye asks: is
// anything marked hidden actually being painted?
test('nothing marked hidden is painted, so the crop dialog shows the photo', { skip }, async () => {
  const file = join(ROOT, 'test', `tmp-hidden-${process.pid}.jpg`);
  writeFileSync(file, await skewedCoverJpeg());
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 412, height: 870, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await (await page.$('#coverUploadFile')).uploadFile(file);
    await page.waitForSelector('#cropDialog[open]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 800));

    const painted = await page.evaluate(() => [...document.querySelectorAll('[hidden]')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => el.id || el.className || el.tagName));
    assert.deepEqual(painted, [], 'elements marked hidden must not be displayed');

    // ...and the cropper is what the crop area actually shows.
    const covered = await page.evaluate(() => {
      const area = document.querySelector('.crop-area').getBoundingClientRect();
      const at = document.elementFromPoint(area.left + area.width / 2, area.top + area.height / 2);
      return !at || !at.closest('.cropper-container');
    });
    assert.equal(covered, false, 'the middle of the crop area is the cropper, not an overlay');
    await page.close();
  } finally {
    rmSync(file, { force: true });
  }
});

// Both of these were reported from a phone and neither shows up at desktop
// widths, so the viewport is the point of the test. The corner canvas was sized
// on width alone, which made a portrait photo taller than the box that clips it
// and put the bottom two handles out of reach; and the six-button action row
// could not wrap, so "Use photo" sat off the right edge.
// The deeper cause of both phone reports. A filter select will not shrink below
// its widest option, so one long shelf name made the document scroll sideways —
// and a sideways-scrolling document drags every <dialog> off-centre with it,
// which is why a button had to be scrolled into view to be tapped. The invariant
// is that the page never scrolls sideways, at any phone width.
test('the page never scrolls sideways, so dialogs stay on screen', { skip }, async () => {
  // A shelf whose name is long enough to widen the filter select.
  await fetch(`${BASE}/api/shelves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: 'Living room', bookcase: 'Tall bookcase by the window', label: 'Shelf 3',
      height_mm: 300, width_mm: 900, depth_mm: 250,
    }),
  });
  const page = await browser.newPage();
  try {
    for (const width of [412, 390, 360, 320]) {
      await page.setViewport({ width, height: 870, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 400));

      const { scrollW, clientW, widest } = await page.evaluate(() => {
        const cw = document.documentElement.clientWidth;
        const widest = [...document.querySelectorAll('body *')]
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter((o) => o.r.width > 0 && o.r.right > cw + 1)
          .sort((a, b) => b.r.right - a.r.right)[0];
        return {
          scrollW: document.documentElement.scrollWidth,
          clientW: cw,
          widest: widest ? `${widest.e.tagName}#${widest.e.id || widest.e.className}` : null,
        };
      });
      assert.ok(scrollW <= clientW + 1,
        `at ${width}px the page scrolls sideways (${scrollW} > ${clientW}), widest offender: ${widest}`);

      await page.click('#addBtn');
      await page.waitForSelector('#editDialog[open]');
      await new Promise((r) => setTimeout(r, 300));
      const fits = await page.evaluate(() => {
        const r = document.querySelector('#editDialog').getBoundingClientRect();
        return r.left >= -1 && r.right <= document.documentElement.clientWidth + 1;
      });
      assert.ok(fits, `at ${width}px the dialog is not fully on screen`);
    }
  } finally {
    await page.close();
  }
});

test('on a phone, no crop-dialog button is pushed off-screen', { skip }, async () => {
  // The skewed cover is the fixture that gets auto-crop *offered*, which is what
  // makes the row six buttons wide — the width that overflowed.
  const file = join(ROOT, 'test', `tmp-phonebtn-${process.pid}.jpg`);
  writeFileSync(file, await skewedCoverJpeg());
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 412, height: 870, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await (await page.$('#coverUploadFile')).uploadFile(file);
    await page.waitForSelector('#cropDialog[open]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 800));

    assert.equal(await page.$eval('#autoCropToggle', (el) => el.hidden), false,
      'the six-button row is what is being measured');
    const offscreen = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll('#cropDialog button')]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && (r.right > vw + 1 || r.left < -1);
        })
        .map((b) => b.id || b.textContent.trim());
    });
    assert.deepEqual(offscreen, [], 'every button in the crop dialog is on screen');
    await page.close();
  } finally {
    rmSync(file, { force: true });
  }
});

test('on a phone, every corner handle is reachable', { skip }, async () => {
  const file = join(ROOT, 'test', `tmp-phone-${process.pid}.jpg`);
  // Portrait, and taller than the crop area is allowed to be — the shape that broke.
  writeFileSync(file, await sharp({
    create: { width: 900, height: 1400, channels: 3, background: { r: 200, g: 190, b: 210 } },
  }).jpeg().toBuffer());
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 412, height: 870, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await (await page.$('#coverUploadFile')).uploadFile(file);
    await page.waitForSelector('#cropDialog[open]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 800));

    await page.click('#cornerMode');
    await page.waitForSelector('#cornerArea:not([hidden])');
    await new Promise((r) => setTimeout(r, 500));

    const unreachable = await page.evaluate(async () => {
      const c = document.querySelector('#cornerCanvas');
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = document.querySelector('#cropImage').src; });
      const box = c.getBoundingClientRect();
      const area = document.querySelector('.crop-area').getBoundingClientRect();
      const vh = document.documentElement.clientHeight, vw = document.documentElement.clientWidth;
      // corners() speaks in image pixels: image -> canvas bitmap -> CSS pixels.
      const k = c.width / img.naturalWidth;
      const sx = box.width / c.width, sy = box.height / c.height;
      const visible = {
        top: Math.max(area.top, 0), bottom: Math.min(area.bottom, vh),
        left: Math.max(area.left, 0), right: Math.min(area.right, vw),
      };
      return window.CornerEditor.corners()
        .map((p) => ({ x: box.left + p.x * k * sx, y: box.top + p.y * k * sy }))
        .filter((p) => p.y > visible.bottom + 1 || p.y < visible.top - 1
                    || p.x > visible.right + 1 || p.x < visible.left - 1).length;
    });
    assert.equal(unreachable, 0, 'all four corner handles are inside the visible crop area');
    await page.close();
  } finally {
    rmSync(file, { force: true });
  }
});

test('a saved cover keeps its photo and can be re-cropped from it later', { skip }, async () => {
  const file = join(ROOT, 'test', `tmp-recrop-${process.pid}.jpg`);
  writeFileSync(file, await skewedCoverJpeg());
  try {
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await page.type('#bookForm [name="title"]', `Recrop ${Date.now()}`);
    await (await page.$('#coverUploadFile')).uploadFile(file);
    await page.waitForSelector('#cropDialog[open]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 700));
    await page.click('#cropUse');
    await new Promise((r) => setTimeout(r, 400));
    await page.click('#bookForm button[type="submit"]');
    await new Promise((r) => setTimeout(r, 700));

    const list = await (await fetch(`${BASE}/api/books?q=Recrop`)).json();
    const saved = list[0];
    assert.ok(saved, 'book saved');
    assert.match(saved.cover_source, /cover-source\?v=/, 'the photo it was cut from is kept');
    const photo = await fetch(`${BASE}/${saved.cover_source}`);
    assert.equal(photo.status, 200);
    assert.ok((await photo.arrayBuffer()).byteLength > 0, 'the original photo is served');

    // Re-open it: the button is offered, and it re-crops from the photo.
    await page.evaluate(async (id) => { const r = await fetch('api/books/' + id); window.openEditBook(await r.json()); }, saved.id);
    await page.waitForSelector('#editDialog[open]');
    assert.equal(await page.$eval('#coverRecropBtn', (el) => el.hidden), false, 're-crop offered');
    await page.click('#coverRecropBtn');
    await page.waitForSelector('#cropDialog[open]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 800));
    const shown = await page.$eval('#cropImage', (el) => el.naturalWidth);
    assert.ok(shown > 0, 'the original photo opened in the cropper');
    await page.click('#cornerMode');       // and corners can be adjusted from there
    await page.waitForSelector('#cornerArea:not([hidden])');
    assert.equal((await page.evaluate(() => window.CornerEditor.corners().length)), 4);
    await page.close();
  } finally {
    rmSync(file, { force: true });
  }
});
