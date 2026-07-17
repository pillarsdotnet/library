// Unit tests for the ISBN metadata lookup (lookup.js), with a mocked fetch.
// Regression guard for the "Foxglove" incident: a rate-limited Google Books must
// surface as a RateLimitError, not a silent "no metadata found".
import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupIsbn, RateLimitError, toMm } from '../lookup.js';

// Build a fake fetch from per-host responders.
function fakeFetch(routes) {
  return async (url) => {
    const which = url.includes('openlibrary.org') ? 'ol' : 'gb';
    const res = routes[which] ?? { status: 200, body: {} };
    return {
      status: res.status ?? 200,
      ok: (res.status ?? 200) >= 200 && (res.status ?? 200) < 300,
      json: async () => res.body ?? {},
      __url: url,
    };
  };
}

test('prefers Open Library and reports its source', async () => {
  const isbn = '9780134685991';
  const data = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'Effective Java', authors: [{ name: 'Joshua Bloch' }] } } },
      gb: { body: { items: [{ volumeInfo: { title: 'Effective Java (Google)' } }] } },
    }),
  });
  assert.equal(data.title, 'Effective Java');
  assert.equal(data.authors, 'Joshua Bloch');
  assert.equal(data.source, 'openlibrary');
});

test('falls back to Google Books when Open Library lacks the book', async () => {
  const isbn = '9780316579896'; // Foxglove — not in Open Library
  const data = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({
      ol: { body: {} }, // empty -> not found
      gb: { body: { items: [{ volumeInfo: { title: 'Foxglove', authors: ['Adalyn Grace'] } }] } },
    }),
  });
  assert.equal(data.title, 'Foxglove');
  assert.equal(data.authors, 'Adalyn Grace');
  assert.equal(data.source, 'googlebooks');
});

test('returns null when neither source has the book', async () => {
  const data = await lookupIsbn('9780000000000', {
    apiKey: null,
    fetch: fakeFetch({ ol: { body: {} }, gb: { body: { totalItems: 0 } } }),
  });
  assert.equal(data, null);
});

test('rate-limited Google Books throws RateLimitError, not "not found"', async () => {
  // This is the Foxglove failure mode: OL missing + GB 429.
  await assert.rejects(
    lookupIsbn('9780316579896', {
      apiKey: null,
      fetch: fakeFetch({ ol: { body: {} }, gb: { status: 429, body: { error: { code: 429 } } } }),
    }),
    RateLimitError,
  );
});

test('still succeeds if Google is rate-limited but Open Library has the book', async () => {
  const isbn = '9780134685991';
  const data = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'Effective Java' } } },
      gb: { status: 429, body: {} },
    }),
  });
  assert.equal(data.title, 'Effective Java');
  assert.equal(data.source, 'openlibrary');
});

test('appends the Google Books API key when provided', async () => {
  let seenGoogleUrl = '';
  const fetch = async (url) => {
    if (url.includes('googleapis.com')) seenGoogleUrl = url;
    return { status: 200, ok: true, json: async () => ({}) };
  };
  await lookupIsbn('9780316579896', { apiKey: 'TESTKEY123', fetch });
  assert.match(seenGoogleUrl, /[?&]key=TESTKEY123(&|$)/);
});

test('toMm converts cm/mm/inches', () => {
  assert.equal(toMm('24.00 cm'), 240);
  assert.equal(toMm('15 mm'), 15);
  assert.equal(toMm('9.1 inches'), 231.1);
  assert.equal(toMm('20.3'), 203); // bare number defaults to cm
  assert.equal(toMm(''), null);
});
