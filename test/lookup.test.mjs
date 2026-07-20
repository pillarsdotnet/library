// Unit tests for the ISBN metadata lookup (lookup.js), with a mocked fetch.
// Regression guard for the "Foxglove" incident: a rate-limited Google Books must
// surface as a RateLimitError, not a silent "no metadata found".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lookupIsbn, RateLimitError, toMm, parseBarnesNoble, normalizeFormat } from '../lookup.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const bnFoxglove = readFileSync(join(FIXTURES, 'barnesnoble-foxglove.html'), 'utf8');
const bnGraph = readFileSync(join(FIXTURES, 'barnesnoble-dcc-graph.html'), 'utf8');

// Build a fake fetch from per-host responders (ol / gb / bn).
function fakeFetch(routes, calls) {
  return async (url) => {
    if (calls) calls.push(url);
    const which = url.includes('openlibrary.org/isbn/') ? 'olEdition'
      : url.includes('openlibrary.org') ? 'ol'
      : url.includes('barnesandnoble.com') ? 'bn' : 'gb';
    // The edition record is optional; absent unless a test supplies one.
    const res = routes[which] ?? (which === 'olEdition' ? { status: 404 } : { status: 200, body: {}, text: '' });
    const status = res.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => res.body ?? {},
      text: async () => res.text ?? '',
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
    return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
  };
  await lookupIsbn('9780316579896', { apiKey: 'TESTKEY123', fetch });
  assert.match(seenGoogleUrl, /[?&]key=TESTKEY123(&|$)/);
});

test('parseBarnesNoble extracts title/author/publisher/cover from a product page', () => {
  const bn = parseBarnesNoble(bnFoxglove);
  assert.equal(bn.title, 'Foxglove (B&N Exclusive Edition) (Belladonna Series #2)');
  assert.equal(bn.authors, 'Adalyn Grace');
  assert.equal(bn.publisher, 'Little, Brown Books for Young Readers');
  assert.match(bn.cover_url, /9780316579896_p0\.jpg/);
});

test('parseBarnesNoble reads the newer @graph / ProductGroup layout', () => {
  // B&N moved the Products into @graph under a ProductGroup, one variant per
  // format, with the author given only as a contributor URL. The old top-level
  // Product lookup found nothing here, so B&N silently stopped being a fallback.
  const bn = parseBarnesNoble(bnGraph, '9780593820247');
  assert.match(bn.title, /^Dungeon Crawler Carl/);
  assert.equal(bn.authors, 'Matt Dinniman', 'author recovered despite being a URL');
  assert.equal(bn.publisher, 'Penguin Publishing Group');
  assert.equal(bn.published_date, '2024-08-27');
});

test('parseBarnesNoble picks the cover of the edition that was asked for', () => {
  // The page offers hardcover and two paperbacks; each variant carries its own EAN.
  const hardcover = parseBarnesNoble(bnGraph, '9780593820247');
  assert.match(hardcover.cover_url, /9780593820247/, 'cover matches the requested ISBN');
  const paperback = parseBarnesNoble(bnGraph, '9780593820254');
  assert.match(paperback.cover_url, /9780593820254/, 'a different edition gets its own cover');
  // Without an ISBN it still returns the group's own details rather than failing.
  assert.match(parseBarnesNoble(bnGraph).title, /^Dungeon Crawler Carl/);
});

test('normalizeFormat maps the bindings sources actually publish', () => {
  for (const [raw, want] of [
    ['Hardcover', 'hardback'], ['https://schema.org/Hardcover', 'hardback'],
    ['Library Binding', 'hardback'],
    ['Paperback', 'paperback'], ['https://schema.org/Paperback', 'paperback'],
    ['Mass Market Paperback', 'paperback'], ['Trade pbk.', 'paperback'],
    ['Kindle Edition', 'ebook'], ['Audio CD', 'audiobook'],
  ]) assert.equal(normalizeFormat(raw), want, `${raw} -> ${want}`);
  // Never guess: an unknown or missing binding stays empty.
  for (const raw of ['', null, undefined, 'Board book', 'Unknown Binding']) {
    assert.equal(normalizeFormat(raw), '', `${raw} should not be guessed`);
  }
});

test('lookup reports the binding when Open Library records one', async () => {
  const isbn = '9780593820247';
  const data = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'Dungeon Crawler Carl' } } },
      olEdition: { body: { physical_format: 'Hardcover' } },
    }),
  });
  assert.equal(data.format, 'hardback', 'hardcover edition reported as hardback');
});

test('lookup leaves the format empty rather than guessing when no source knows it', async () => {
  const isbn = '9780593820254';
  const data = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({ ol: { body: { [`ISBN:${isbn}`]: { title: 'Dungeon Crawler Carl' } } } }),
  });
  assert.equal(data.format, '', 'no binding recorded, so nothing is assumed');
});

test('Barnes & Noble reports the binding of the edition that was asked for', () => {
  assert.equal(parseBarnesNoble(bnGraph, '9780593820247').format, 'hardback');
  assert.equal(parseBarnesNoble(bnGraph, '9780593820254').format, 'paperback');
});

test('parseBarnesNoble returns null for a non-product page', () => {
  assert.equal(parseBarnesNoble('<html><body>nope</body></html>'), null);
});

test('falls back to Barnes & Noble when Open Library and Google Books both miss', async () => {
  const data = await lookupIsbn('9780316579896', {
    apiKey: null,
    fetch: fakeFetch({
      ol: { body: {} },
      gb: { body: { totalItems: 0 } },
      bn: { text: bnFoxglove },
    }),
  });
  assert.equal(data.source, 'barnesnoble');
  assert.equal(data.title, 'Foxglove (B&N Exclusive Edition) (Belladonna Series #2)');
  assert.equal(data.authors, 'Adalyn Grace');
});

test('does NOT hit Barnes & Noble when a primary source already has the book', async () => {
  const calls = [];
  const isbn = '9780134685991';
  await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({ ol: { body: { [`ISBN:${isbn}`]: { title: 'Effective Java' } } } }, calls),
  });
  assert.ok(!calls.some((u) => u.includes('barnesandnoble.com')), 'B&N should not be queried when OL/GB succeed');
});

test('B&N fallback still runs when Google Books is rate-limited', async () => {
  const data = await lookupIsbn('9780316579896', {
    apiKey: null,
    fetch: fakeFetch({
      ol: { body: {} },
      gb: { status: 429, body: {} },
      bn: { text: bnFoxglove },
    }),
  });
  assert.equal(data.source, 'barnesnoble');
});

// Fetch where Google Books returns 503 for its first `googleFailFirst` calls,
// then a real result — to exercise the transient-5xx retry.
function flakyGoogleFetch({ googleFailFirst = 0, googleTitle = null }) {
  let g = 0;
  const empty = { status: 200, ok: true, json: async () => ({}), text: async () => '' };
  return async (url) => {
    if (url.includes('openlibrary.org') || url.includes('barnesandnoble.com')) return empty;
    g += 1;
    if (g <= googleFailFirst) {
      return { status: 503, ok: false, json: async () => ({ error: { code: 503 } }), text: async () => '' };
    }
    const body = googleTitle ? { totalItems: 1, items: [{ volumeInfo: { title: googleTitle } }] } : { totalItems: 0 };
    return { status: 200, ok: true, json: async () => body, text: async () => '' };
  };
}

test('retries a transient 503 from Google Books, then succeeds', async () => {
  const data = await lookupIsbn('9781643857220', {
    apiKey: 'k', retryDelayMs: 0,
    fetch: flakyGoogleFetch({ googleFailFirst: 2, googleTitle: 'Practical Magic' }),
  });
  assert.equal(data.title, 'Practical Magic');
  assert.equal(data.source, 'googlebooks');
});

test('gives up after retries when 503 persists (returns null, not a false rate-limit)', async () => {
  const data = await lookupIsbn('9781643857220', {
    apiKey: 'k', retries: 2, retryDelayMs: 0,
    fetch: flakyGoogleFetch({ googleFailFirst: 99 }),
  });
  assert.equal(data, null);
});

test('toMm converts cm/mm/inches', () => {
  assert.equal(toMm('24.00 cm'), 240);
  assert.equal(toMm('15 mm'), 15);
  assert.equal(toMm('9.1 inches'), 231); // whole mm
  assert.equal(toMm('20.3'), 203); // bare number defaults to cm
  assert.equal(toMm(''), null);
});
