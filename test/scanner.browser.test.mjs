// Browser regression tests for the barcode scanner, driven with a fake camera.
//
// Guards against the Android crash where Html5Qrcode.start() was called with a
// multi-key camera config ("'cameraIdOrConfig' object should have exactly 1
// key ... found 4 keys"), plus general "the camera actually starts" coverage on
// both engines (html5-qrcode native path and the Quagga fallback).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
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

  // Inline covers are returned as a reference, not embedded.
  assert.equal(withCover.cover_url, `api/books/${withCover.id}/cover`, 'data: cover replaced by a reference');
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

test('series field: new entry creates the series, prompts for order, and bumps on collision', { skip }, async () => {
  const seriesTitle = 'Test Series ' + Date.now();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });

  const addBook = async (title, order) => {
    await page.click('#addBtn');
    await page.waitForSelector('#editDialog[open]');
    await page.type('#bookForm [name="title"]', title);
    await page.type('#seriesInput', seriesTitle);
    await page.click('#bookForm [name="authors"]');          // blur commits the series box
    await page.waitForSelector('#seriesOrderDialog[open]', { timeout: 4000 });
    await page.$eval('#seriesOrderInput', (el, v) => { el.value = v; }, String(order));
    await page.click('#seriesOrderSave');
    await new Promise((r) => setTimeout(r, 200));
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

  // Adding at an occupied order pushes the rest down.
  await addBook('S Inserted', 2);
  books = await (await fetch(`${BASE}/api/series/${s.id}/books`)).json();
  assert.deepEqual(books.map((b) => `${b.order}:${b.title}`), ['1:S One', '2:S Inserted', '3:S Two', '4:S Three']);
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
    bookcases: [...rg.querySelectorAll('.bookcase-group')].map((bc) => ({
      bookcase: bc.querySelector('.bookcase-heading').firstChild.textContent.trim(),
      shelves: [...bc.querySelectorAll('.shelf-card h3')].map((h) => h.textContent.trim()),
    })),
  })));

  const aRoom = tree.find((r) => r.room === `Aroom${stamp}`);
  assert.ok(aRoom, 'room group rendered');
  assert.deepEqual(aRoom.bookcases.map((b) => b.bookcase), ['Birch', 'Oak'], 'bookcases sorted within room');
  assert.deepEqual(aRoom.bookcases.find((b) => b.bookcase === 'Oak').shelves, ['1L', '2L'], 'shelves sorted within bookcase');
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
