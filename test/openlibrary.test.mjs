// What may and may not be offered back to Open Library.
//
// These guard the one rule that cannot be allowed to slip: a value Open Library
// already holds is never touched. Everything else in this feature is a
// convenience; that rule is the difference between contributing and vandalising
// a public catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposalsFor, fetchEdition, sendField, FIELD_COMMENTS } from '../openlibrary.js';

const BOOK = {
  isbn: '9798892426183',
  title: 'Violet Thistlewaite is Not a Villain Anymore',
  cover_url: 'data:image/jpeg;base64,AAAA',
  height_mm: 210, width_mm: 140, thickness_mm: 25,
  format: 'hardback',
  page_count: 342,
};
const fieldsOf = (props) => props.map((p) => p.field).sort();

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
