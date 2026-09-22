// What may and may not be offered back to Open Library.
//
// These guard the one rule that cannot be allowed to slip: a value Open Library
// already holds is never touched. Everything else in this feature is a
// convenience; that rule is the difference between contributing and vandalising
// a public catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposalsFor, fetchEdition, sendField, FIELD_COMMENTS,
  importAllowed, importPayload, sendImport, sourcePrefix, sendCover,
} from '../openlibrary.js';

const BOOK = {
  isbn: '9798892426183',
  title: 'Violet Thistlewaite is Not a Villain Anymore',
  cover_url: 'data:image/jpeg;base64,AAAA',
  height_mm: 210, width_mm: 140, thickness_mm: 25,
  format: 'hardback',
  page_count: 342,
};
const fieldsOf = (props) => props.map((p) => p.field).sort();

// Edit comments are a public log, and a log in three tenses reads as three
// people. Present imperative, the same as a commit subject.
test('every edit comment is written in the present imperative', () => {
  for (const [field, comment] of Object.entries(FIELD_COMMENTS)) {
    const firstWord = comment.split(/\s+/)[0];
    assert.doesNotMatch(firstWord, /(ing|ed|s)$/i,
      `${field}: "${firstWord}" is not imperative — write "Add", not "Adding"/"Added"/"Adds"`);
  }
});

test('an empty edition record is offered everything we can answer', () => {
  assert.deepEqual(fieldsOf(proposalsFor(BOOK, {})),
    ['cover', 'number_of_pages', 'physical_dimensions', 'physical_format']);
});

test('a field Open Library already holds is never offered', () => {
  const full = {
    covers: [12345],
    physical_dimensions: '8 x 5 x 1 inches',
    physical_format: 'paperback',      // disagrees with ours; still not ours to change
    number_of_pages: 350,              // ditto
  };
  assert.deepEqual(proposalsFor(BOOK, full), [], 'nothing to add to a complete record');
});

test('page count is offered only when absent, whatever the disagreement', () => {
  // The convention (highest explicitly numbered page) makes honest disagreement
  // normal, so a count that is merely *different* is left alone.
  assert.deepEqual(fieldsOf(proposalsFor(BOOK, { number_of_pages: 344 })).includes('number_of_pages'), false);
  assert.equal(fieldsOf(proposalsFor(BOOK, {})).includes('number_of_pages'), true);
  // ...and when it is sent, it says which convention produced it.
  assert.match(FIELD_COMMENTS.number_of_pages, /highest explicitly numbered page/i);
});

test('emptiness is judged on substance, not on the key being present', () => {
  assert.equal(fieldsOf(proposalsFor(BOOK, { covers: [] })).includes('cover'), true, 'no covers listed');
  assert.equal(fieldsOf(proposalsFor(BOOK, { covers: [-1] })).includes('cover'), true, 'OL uses -1 for "removed"');
  assert.equal(fieldsOf(proposalsFor(BOOK, { physical_format: '' })).includes('physical_format'), true);
  assert.equal(fieldsOf(proposalsFor(BOOK, { number_of_pages: 0 })).includes('number_of_pages'), true);
});

test('we offer nothing we do not actually have', () => {
  const bare = { isbn: '123', title: 'Bare', format: 'ebook' };
  assert.deepEqual(proposalsFor(bare, {}), [], 'no cover, no measurements, no count');
  // Partial measurements are not published: two thirds of a dimension string is
  // worse than none, because it looks authoritative.
  const partial = { ...BOOK, thickness_mm: null, cover_url: '', page_count: null, format: 'ebook' };
  assert.deepEqual(proposalsFor(partial, {}), []);
});

test('a digital format is never offered as a physical binding', () => {
  for (const format of ['ebook', 'audiobook', 'other']) {
    const props = proposalsFor({ ...BOOK, format }, {});
    assert.equal(fieldsOf(props).includes('physical_format'), false, `${format} is not a binding`);
  }
});

test('dimensions are sent in the centimetre form Open Library uses', () => {
  const [dim] = proposalsFor(BOOK, {}).filter((p) => p.field === 'physical_dimensions');
  assert.equal(dim.value, '21 x 14 x 2.5 centimeters');
});

// The series tag is the one field that edits the work rather than the edition,
// and the one whose stored form differs from the form the contributors' guide
// shows: you type [series:Name] into the form, `series:Name` is what lands in
// the work's subjects.
test('series is offered as a work subject tag, in stored form', () => {
  const book = { ...BOOK, series_title: 'Discworld' };
  const [p] = proposalsFor(book, {}, { subjects: ['Fiction'] }).filter((x) => x.field === 'series');
  assert.equal(p.value, 'series:Discworld', 'no brackets — those are edit-form syntax');
  assert.equal(p.target, 'work', 'the tag belongs to the work, not the edition');
});

test('a work that already carries any series tag is left alone', () => {
  const book = { ...BOOK, series_title: 'Discworld' };
  const tagged = { subjects: ['Fiction', 'series:The Discworld Series'] };
  assert.equal(proposalsFor(book, {}, tagged).some((p) => p.field === 'series'), false,
    'a differently-worded tag is a disagreement, not a gap');
});

test('no series tag without a work record or without a series', () => {
  const book = { ...BOOK, series_title: 'Discworld' };
  assert.equal(proposalsFor(book, {}, null).some((p) => p.field === 'series'), false, 'no work fetched');
  assert.equal(proposalsFor(BOOK, {}, { subjects: [] }).some((p) => p.field === 'series'), false, 'book is in no series');
});

test('sending a series tag appends to the work subjects and keeps the rest', async () => {
  const calls = [];
  const doFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (opts.method === 'PUT') return { ok: true, status: 200 };
    return { ok: true, json: async () => ({ key: '/works/OL1W', title: 'Kept', subjects: ['Fiction', 'Humor'] }) };
  };
  await sendField('OL1W', 'series', 'series:Discworld', 'c', 'sess=x', doFetch);
  const put = calls.find((c) => c.opts.method === 'PUT');
  assert.match(put.url, /\/works\/OL1W\.json$/, 'edits the work, not the edition');
  const body = JSON.parse(put.opts.body);
  assert.deepEqual(body.subjects, ['Fiction', 'Humor', 'series:Discworld'],
    'the existing subjects survive — they are a communal pile, not ours to replace');
  assert.equal(body.title, 'Kept');
});

test('fetchEdition ignores anything that is not a real edition record', async () => {
  const notFound = async () => ({ ok: false, status: 404 });
  assert.equal(await fetchEdition('9798892426183', notFound), null);
  assert.equal(await fetchEdition('', notFound), null, 'no ISBN, no lookup');

  // A work or author key is not something we may add edition fields to.
  const work = async () => ({ ok: true, json: async () => ({ key: '/works/OL1W' }) });
  assert.equal(await fetchEdition('9798892426183', work), null);
});

test('sending re-checks the live record and refuses to overwrite a filled blank', async () => {
  // The queue can sit for days; someone else may have filled the gap meanwhile.
  const filledSince = async () => ({ ok: true, json: async () => ({ key: '/books/OL1M', number_of_pages: 350 }) });
  await assert.rejects(
    () => sendField('OL1M', 'number_of_pages', '342', 'c', 'cookie', filledSince),
    /already has number_of_pages/,
  );
});

test('a successful send PUTs the record back with the edit comment attached', async () => {
  const calls = [];
  const doFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (opts.method === 'PUT') return { ok: true, status: 200 };
    return { ok: true, json: async () => ({ key: '/books/OL1M', title: 'Kept' }) };
  };
  await sendField('OL1M', 'number_of_pages', '342', FIELD_COMMENTS.number_of_pages, 'sess=x', doFetch);
  const put = calls.find((c) => c.opts.method === 'PUT');
  const body = JSON.parse(put.opts.body);
  assert.equal(body.number_of_pages, 342, 'sent as a number, not a string');
  assert.equal(body.title, 'Kept', 'the rest of the record survives the edit');
  assert.match(body._comment, /highest explicitly numbered page/i);
  assert.equal(put.opts.headers.Cookie, 'sess=x');
});

// Importing creates records rather than filling blanks, so the tests here are
// mostly about the things that must NOT happen.
test('importing is off unless explicitly switched on', async () => {
  delete process.env.OPENLIBRARY_ALLOW_IMPORT;
  assert.equal(importAllowed(), false, 'off by default');
  await assert.rejects(() => sendImport({}, 'c', {}, async () => {}), /switched off/);
  process.env.OPENLIBRARY_ALLOW_IMPORT = 'true';
  assert.equal(importAllowed(), true);
  delete process.env.OPENLIBRARY_ALLOW_IMPORT;
});

test('an import payload carries a strong identifier and a source record', () => {
  const book = { ...BOOK, authors: 'Emily Krempholtz', publisher: 'Podium', published_date: '2024' };
  const rec = importPayload(book, 'examplebot');
  assert.equal(rec.title, BOOK.title);
  assert.deepEqual(rec.isbn_13, ['9798892426183'], '13 digits go in isbn_13');
  assert.deepEqual(rec.source_records, ['examplebot:9798892426183']);
  assert.deepEqual(rec.authors, [{ name: 'Emily Krempholtz' }]);
  assert.deepEqual(rec.publishers, ['Podium']);
  assert.equal(rec.physical_dimensions, '21 x 14 x 2.5 centimeters');
  // A 10-digit ISBN belongs in the other field.
  assert.deepEqual(importPayload({ ...book, isbn: '0261102214' }, 'p').isbn_10, ['0261102214']);
});

// One edition, one stamp. A book catalogued by its 10-digit ISBN and the same
// book catalogued by its 13-digit ISBN must leave the same mark in Open
// Library, or our own imports look like two different sources to anyone
// reading them back — including us.
test('the source record stamp is single-valued across ISBN spellings', () => {
  const ten = importPayload({ title: 'The Fellowship of the Ring', isbn: '0261102214' }, 'p');
  const thirteen = importPayload({ title: 'The Fellowship of the Ring', isbn: '9780261102217' }, 'p');
  assert.deepEqual(ten.source_records, ['p:9780261102217'], 'a 10-digit ISBN stamps the 13-digit form');
  assert.deepEqual(ten.source_records, thirteen.source_records, 'both spellings stamp alike');
  // Hyphens and a lowercase check digit are presentation, not identity.
  const messy = importPayload({ title: 'Quidditch Through the Ages', isbn: '0-4394-2089-x' }, 'p');
  assert.deepEqual(messy.source_records, ['p:9780439420891']);
  assert.deepEqual(messy.isbn_10, ['043942089X'], "the printed ISBN keeps its form, with 'X' spelled one way");
  // An ISBN that fails its check digit cannot be canonicalised, and an
  // unverifiable identifier is not one to found a public record on.
  assert.equal(importPayload({ title: 'Typo', isbn: '9780261102216' }, 'p'), null,
    'a bad check digit is not imported');
});

test('nothing too thin to identify is ever offered for import', () => {
  assert.equal(importPayload({ title: 'No ISBN' }, 'p'), null, 'no identifier, no import');
  assert.equal(importPayload({ isbn: '9798892426183' }, 'p'), null, 'no title, no import');
  // The stamp is not optional: a caller that hands over no prefix gets no record.
  assert.equal(importPayload(BOOK, ''), null, 'no source prefix, no import');
});

// The prefix names the catalogue an import came from, so it is settled once for
// the installation rather than per book — but one installation is not every
// installation, and a deployment that has agreed a different prefix with Open
// Library must be able to say so without editing the source.
test('the source prefix defaults, and the environment overrides it', () => {
  const saved = process.env.OPENLIBRARY_SOURCE_PREFIX;
  try {
    delete process.env.OPENLIBRARY_SOURCE_PREFIX;
    assert.equal(sourcePrefix(), 'pillarsdotnet_library', 'unconfigured falls back to the default');
    assert.deepEqual(importPayload(BOOK).source_records, ['pillarsdotnet_library:9798892426183']);

    process.env.OPENLIBRARY_SOURCE_PREFIX = 'otherbot';
    assert.deepEqual(importPayload(BOOK).source_records, ['otherbot:9798892426183'],
      'a configured prefix wins over the default');

    // Empty is a deliberate "no prefix", not a request for the default back.
    process.env.OPENLIBRARY_SOURCE_PREFIX = '';
    assert.equal(sourcePrefix(), '');
    assert.equal(importPayload(BOOK), null, 'switched off explicitly: no stamp, no import');

    // A prefix that would split or mangle the stamp is refused rather than sent
    // wrong — every reader of the field takes the prefix as value.split(':')[0].
    for (const bad of ['two words', 'has:colon', '_leading', 'pillars/library']) {
      process.env.OPENLIBRARY_SOURCE_PREFIX = bad;
      assert.equal(sourcePrefix(), '', `${JSON.stringify(bad)} is not a usable prefix`);
      assert.equal(importPayload(BOOK), null, `${JSON.stringify(bad)} is not offered for import`);
    }
  } finally {
    if (saved === undefined) delete process.env.OPENLIBRARY_SOURCE_PREFIX;
    else process.env.OPENLIBRARY_SOURCE_PREFIX = saved;
  }
});

// Open Library gates its browser forms behind a human-verification challenge,
// which a bot account cannot pass. The status code alone reads like a bug in
// this app, so neither refusal is allowed to surface as a bare number.
test('a cover Open Library will not take from a program says so', async () => {
  const stub = (status, location) => async () => ({
    ok: false, status, headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) },
  });

  await assert.rejects(
    () => sendCover('OL1M', Buffer.from([0xff, 0xd8]), 'session=x', stub(405, null)),
    /not accepting cover uploads from programs/,
    'a 405 from their front end is explained, not echoed',
  );
  await assert.rejects(
    () => sendCover('OL1M', Buffer.from([0xff, 0xd8]), 'session=x', stub(303, 'https://openlibrary.org/verify_human?next=/books/OL1M/add-cover')),
    /human verification/,
    'a redirect to the challenge page is a failure, not a success',
  );
  // A redirect back to the book page is what success actually looks like.
  assert.equal(
    await sendCover('OL1M', Buffer.from([0xff, 0xd8]), 'session=x', stub(303, 'https://openlibrary.org/books/OL1M')),
    true,
  );
});

test('a refused import surfaces Open Library\'s own reason', async () => {
  process.env.OPENLIBRARY_ALLOW_IMPORT = 'true';
  try {
    const refuse = async () => ({
      ok: false, status: 400,
      text: async () => JSON.stringify({ success: false, error_code: 'invalid-value', error: 'title: too short' }),
    });
    await assert.rejects(() => sendImport({ title: '' }, 'c', {}, refuse), /too short/);
    // A 200 carrying success:false is still a refusal.
    const sneaky = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: false, error: 'nope' }) });
    await assert.rejects(() => sendImport({}, 'c', {}, sneaky), /nope/);
  } finally { delete process.env.OPENLIBRARY_ALLOW_IMPORT; }
});

test('preview mode asks Open Library not to save', async () => {
  process.env.OPENLIBRARY_ALLOW_IMPORT = 'true';
  try {
    const urls = [];
    const ok = async (url) => { urls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ edition: { key: '/books/OL9M', status: 'created' } }) }; };
    await sendImport({ title: 'x' }, 'c', { preview: true }, ok);
    await sendImport({ title: 'x' }, 'c', { preview: false }, ok);
    assert.match(urls[0], /\/api\/import\?preview=true$/, 'the rehearsal says preview');
    assert.match(urls[1], /\/api\/import$/, 'the real one does not');
  } finally { delete process.env.OPENLIBRARY_ALLOW_IMPORT; }
});

// Open Library's front end answers some requests itself, and a bare status code
// then reads as though the catalogue disagreed with us when it never saw the
// edit. Measured against the live site: a PUT whose body contains a quote
// followed by "--" — the SQL comment signature, and how a MARC description ends
// before its source attribution — is refused with nginx's own 403 page.
test('a refusal from the front door is reported as one, and carries what it said', async () => {
  const record = {
    key: '/books/OL1M', type: { key: '/type/edition' },
    description: { type: '/type/text', value: 'A novel about the way"--' },
  };
  const nginx403 = '<html><head><title>403 Forbidden</title></head>'
    + '<body><center><h1>403 Forbidden</h1></center><hr><center>nginx/1.30.5</center></body></html>';

  const fetchWith = (status, body) => async (url, opts) => (opts?.method === 'PUT'
    ? { ok: false, status, text: async () => body }
    : { ok: true, json: async () => record });

  const blocked = await sendField('OL1M', 'physical_dimensions', '20 x 13 x 2 centimeters', 'c', 'session=x',
    fetchWith(403, nginx403)).then(() => null, (e) => e);
  assert.match(blocked.message, /front end refused this record/, 'names the cause, not the number');
  assert.match(blocked.message, /"--"/, 'and says what in the record trips it');
  assert.equal(blocked.status, 403, 'the status is kept for the log');
  assert.match(blocked.detail, /nginx/, 'along with what came back');

  // The same status without that signature is still attributed to the front
  // door, but not blamed on a record that did not cause it.
  const plain = { ...record, description: { type: '/type/text', value: 'An ordinary summary.' } };
  const other = await sendField('OL1M', 'physical_dimensions', '20 x 13 x 2 centimeters', 'c', 'session=x',
    async (url, opts) => (opts?.method === 'PUT'
      ? { ok: false, status: 403, text: async () => nginx403 }
      : { ok: true, json: async () => plain })).then(() => null, (e) => e);
  assert.match(other.message, /front end refused this edit \(403\)/);
  assert.doesNotMatch(other.message, /"--"/);

  // And a refusal from the catalogue itself still reads as one.
  const app = await sendField('OL1M', 'physical_dimensions', '20 x 13 x 2 centimeters', 'c', 'session=x',
    async (url, opts) => (opts?.method === 'PUT'
      ? { ok: false, status: 400, text: async () => '{"error":"bad_data"}' }
      : { ok: true, json: async () => plain })).then(() => null, (e) => e);
  assert.match(app.message, /rejected the edit \(400\)/);
  assert.equal(app.status, 400);
  assert.match(app.detail, /bad_data/);
});
