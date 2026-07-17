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
