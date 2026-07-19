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

test('typing a new genre in the book form prompts for a definition and saves it', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('#addBtn');
  await page.waitForSelector('#editDialog[open]');
  await page.type('#bookForm [name="title"]', 'Genre Prompt Book');
  const newGenre = 'Steampunk ' + Date.now();
  await page.type('#bookForm [name="genre"]', newGenre);
  await page.click('#bookForm button[type="submit"]');

  // New-genre definition dialog should appear.
  await page.waitForSelector('#newGenreDialog[open]', { timeout: 4000 });
  assert.match(await page.$eval('#newGenrePrompt', (el) => el.textContent), /new genre/i);
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
