// The edition/copy split as the API presents it: what two copies of one book
// share, and what stays private to each. These go through HTTP rather than the
// schema, because the split is only worth anything if it survives the round trip
// through the routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/home-library-copies-${process.pid}.db`;
// Its own covers directory: they default to one beside the database, so every
// test database in /tmp would otherwise share /tmp/covers and overwrite each
// other's files — copy ids restart at 1 in each. See cover.test.mjs.
const COVERS_DIR = DB_PATH.replace(/\.db$/, '-covers');

let server;

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test.before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH, COVERS_DIR },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/meta`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(() => {
  server?.kill();
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  rmSync(COVERS_DIR, { recursive: true, force: true });
});

test('two copies of one book, entered as ISBN-10 and ISBN-13, share an edition', async () => {
  const a = await api('POST', '/api/books', {
    title: 'Dune', isbn: '0441013597', authors: 'Frank Herbert', publisher: 'Ace',
    page_count: 412, height_mm: 175, format: 'paperback',
    jacket: 'present', status: 'read', notes: 'my reading copy',
  });
  const b = await api('POST', '/api/books', {
    title: 'Dune', isbn: '978-0-441-01359-3',
    jacket: 'missing', status: 'tbr', notes: 'the lending copy',
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.id, b.body.id, 'two distinct physical copies');
  assert.equal(a.body.edition_id, b.body.edition_id, 'one book, however the ISBN was spelled');

  // The second copy was entered with nothing but a title and an ISBN, and comes
  // back fully described: that is the whole point of hanging metadata off the ISBN.
  assert.equal(b.body.authors, 'Frank Herbert');
  assert.equal(b.body.publisher, 'Ace');
  assert.equal(b.body.page_count, 412);
  assert.equal(b.body.height_mm, 175);

  // …while the four per-copy facts stay its own.
  assert.equal(b.body.jacket, 'missing');
  assert.equal(b.body.status, 'tbr');
  assert.equal(b.body.notes, 'the lending copy');
  assert.equal(a.body.notes, 'my reading copy');
});

test('editing shared metadata on one copy shows on the other; per-copy edits do not', async () => {
  const list = (await api('GET', '/api/books?limit=0')).body;
  const [a, b] = list.filter((x) => x.title === 'Dune').sort((x, y) => x.id - y.id);

  await api('PUT', `/api/books/${a.id}`, { publisher: 'Ace Books', page_count: 535 });
  const bAfter = (await api('GET', `/api/books/${b.id}`)).body;
  assert.equal(bAfter.publisher, 'Ace Books', 'a correction to the book reaches every copy');
  assert.equal(bAfter.page_count, 535);

  await api('PUT', `/api/books/${a.id}`, { notes: 'annotated in the margins', status: 'loaned' });
  const bStill = (await api('GET', `/api/books/${b.id}`)).body;
  assert.equal(bStill.notes, 'the lending copy', "one copy's notes are not the other's");
  assert.equal(bStill.status, 'tbr', 'nor is its reading status');
});

test('genres and series are recorded once for the book, not once per copy', async () => {
  const list = (await api('GET', '/api/books?limit=0')).body;
  const [a, b] = list.filter((x) => x.title === 'Dune').sort((x, y) => x.id - y.id);
  const genre = (await api('POST', '/api/genres', { name: 'Science Fiction' })).body;

  await api('PUT', `/api/books/${a.id}`, { genre_ids: [genre.id] });
  const bAfter = (await api('GET', `/api/books/${b.id}`)).body;
  assert.deepEqual(bAfter.genres.map((g) => g.name), ['Science Fiction'],
    'tagging the book tags it for every copy');

  const series = (await api('POST', '/api/series', { title: 'Dune Chronicles' })).body;
  await api('POST', `/api/series/${series.id}/books`, { book_id: a.id, order: 1 });
  const members = (await api('GET', `/api/series/${series.id}/books`)).body;
  assert.equal(members.length, 1, 'owning two copies does not put the volume in the series twice');
  const bSeries = (await api('GET', `/api/books/${b.id}`)).body;
  assert.equal(bSeries.series?.title, 'Dune Chronicles', 'and both copies know they are in it');
});

test('a book with an unverifiable ISBN is never merged into another', async () => {
  // Same digits, one transposition, neither passing its check digit.
  const a = await api('POST', '/api/books', { title: 'Typo One', isbn: '9780441013594' });
  const b = await api('POST', '/api/books', { title: 'Typo Two', isbn: '9780441013594' });
  assert.notEqual(a.body.edition_id, b.body.edition_id,
    'an ISBN we cannot verify must not fuse two different books');
  assert.equal(b.body.title, 'Typo Two', 'and neither title is overwritten by the other');
  // The value the user typed is still shown back to them.
  assert.equal(a.body.isbn, '9780441013594');
});

test('books with no ISBN at all stay separate', async () => {
  const a = await api('POST', '/api/books', { title: 'Hand-bound Journal' });
  const b = await api('POST', '/api/books', { title: 'Another Journal' });
  assert.notEqual(a.body.edition_id, b.body.edition_id);
});

test('correcting a copy\'s ISBN moves it to the right book, carrying its metadata', async () => {
  const made = (await api('POST', '/api/books', {
    title: 'Mistyped', isbn: '9780596000271', authors: 'Eric S. Raymond', page_count: 241,
    notes: 'this copy', jacket: 'present',
  })).body;
  const before = made.edition_id;

  const fixed = (await api('PUT', `/api/books/${made.id}`, { isbn: '0441013597' })).body;
  assert.notEqual(fixed.edition_id, before, 'it is a copy of a different book now');
  assert.equal(fixed.notes, 'this copy', 'but it is the same physical object');
  assert.equal(fixed.jacket, 'present');
  assert.equal(fixed.isbn, '9780441013593', 'stored canonically');
});

test('deleting one copy leaves the other, and a missing copy is a 404', async () => {
  const a = (await api('POST', '/api/books', { title: 'Twice Owned', isbn: '9780306406157' })).body;
  const b = (await api('POST', '/api/books', { title: 'Twice Owned', isbn: '9780306406157' })).body;
  assert.equal(a.edition_id, b.edition_id);

  assert.equal((await api('DELETE', `/api/books/${a.id}`)).status, 204);
  assert.equal((await api('GET', `/api/books/${b.id}`)).status, 200, 'the other copy survives');
  assert.equal((await api('DELETE', `/api/books/${a.id}`)).status, 404, 'and it is really gone');
});

test('an e-book carrying the print ISBN is not merged into the print edition', async () => {
  // E-books have ASINs, not ISBNs, and importers staple the print ISBN onto the
  // e-book record. Merging on the ISBN alone fused a Kindle file to a hardback
  // and left one of them reporting the other's format and dimensions.
  const print = (await api('POST', '/api/books', {
    title: "Heroes' Feast", isbn: '9781984858900', format: 'hardback',
    height_mm: 248, width_mm: 224, thickness_mm: 25, status: 'read',
  })).body;
  const ebook = (await api('POST', '/api/books', {
    title: "Heroes' Feast", isbn: '1984858904', format: 'ebook', status: 'tbr',
  })).body;

  assert.notEqual(print.edition_id, ebook.edition_id, 'same ISBN, different objects');
  assert.equal(print.format, 'hardback', 'the hardback is still a hardback');
  assert.equal(ebook.format, 'ebook', 'and the e-book is still an e-book');
  assert.equal(ebook.height_mm, null, 'an e-book does not inherit physical dimensions');
  assert.equal(print.height_mm, 248);
});

test('two print copies of one ISBN still merge', async () => {
  // The narrowing above must not cost us the case the split exists for.
  const a = (await api('POST', '/api/books', { title: 'Shared', isbn: '9780679783268', format: 'paperback', publisher: 'Vintage' })).body;
  const b = (await api('POST', '/api/books', { title: 'Shared', isbn: '0679783261', format: 'paperback' })).body;
  assert.equal(a.edition_id, b.edition_id);
  assert.equal(b.publisher, 'Vintage', 'and the second copy still arrives described');
});

test('a client that omits format matches the paperback it means', async () => {
  const a = (await api('POST', '/api/books', { title: 'Implicit', isbn: '9780140328721', page_count: 96 })).body;
  const b = (await api('POST', '/api/books', { title: 'Implicit', isbn: '0140328726' })).body;
  assert.equal(a.edition_id, b.edition_id, 'the column default and the match key agree');
  assert.equal(b.page_count, 96);
});

test('correcting a copy\'s format moves it to its own edition, keeping the ISBN', async () => {
  const a = (await api('POST', '/api/books', { title: 'Rebound', isbn: '9780061120084', format: 'paperback' })).body;
  const b = (await api('POST', '/api/books', { title: 'Rebound', isbn: '9780061120084', format: 'paperback' })).body;
  assert.equal(a.edition_id, b.edition_id, 'both start as paperbacks of one edition');

  const fixed = (await api('PUT', `/api/books/${b.id}`, { format: 'hardback' })).body;
  assert.notEqual(fixed.edition_id, a.edition_id, 'the corrected copy moves');
  assert.equal(fixed.format, 'hardback');
  assert.equal(fixed.isbn, '9780061120084', 'and does not lose its ISBN on the way');
  const untouched = (await api('GET', `/api/books/${a.id}`)).body;
  assert.equal(untouched.format, 'paperback', 'the other copy is not rebound with it');
});

test('the served page shows the running version, with no placeholder left behind', async () => {
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const html = await (await fetch(`${BASE}/`)).text();

  // Assets are cache-busted by version, so a device showing a stale build is the
  // hard case to diagnose — the version has to be readable from the page itself.
  assert.match(html, new RegExp(`<title>Home Library ${version.replace(/\./g, '\\.')}</title>`));
  assert.match(html, new RegExp(`<span class="version">${version.replace(/\./g, '\\.')}</span>`));
  // Every placeholder must be substituted; a literal one reaching the browser is
  // the failure this test exists to catch.
  assert.ok(!html.includes('__VERSION__'), 'no unsubstituted __VERSION__');
  assert.ok(!html.includes('__V__'), 'no unsubstituted __V__');
  assert.ok(!html.includes('__BASE__'), 'no unsubstituted __BASE__');
});
