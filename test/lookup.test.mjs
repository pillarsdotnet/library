// Unit tests for the ISBN metadata lookup (lookup.js), with a mocked fetch.
// Regression guard for the "Foxglove" incident: a rate-limited Google Books must
// surface as a RateLimitError, not a silent "no metadata found".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lookupIsbn, RateLimitError, toMm, parseBarnesNoble, parseLocMods, parseIsbndbBook, normalizeFormat, parseSeries } from '../lookup.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const bnFoxglove = readFileSync(join(FIXTURES, 'barnesnoble-foxglove.html'), 'utf8');
const bnGraph = readFileSync(join(FIXTURES, 'barnesnoble-dcc-graph.html'), 'utf8');

// Build a fake fetch from per-host responders (ol / gb / bn).
function fakeFetch(routes, calls) {
  return async (url) => {
    if (calls) calls.push(url);
    const which = url.includes('openlibrary.org/isbn/') ? 'olEdition'
      : url.includes('openlibrary.org/works/') ? 'olWork'
      : url.includes('openlibrary.org') ? 'ol'
      : url.includes('barnesandnoble.com') ? 'bn'
      : url.includes('isbndb.com') ? 'isbndb'
      : url.includes('/lcdb?') ? 'loc' : 'gb';
    // The edition record is optional; absent unless a test supplies one, and
    // so are the Library of Congress and ISBNdb.
    const res = routes[which]
      ?? ((which === 'olEdition' || which === 'olWork' || which === 'loc' || which === 'isbndb')
        ? { status: 404 } : { status: 200, body: {}, text: '' });
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
    ['Staple Bound', 'stapled'], ['Saddle Stitch', 'stapled'],
    ['Comic', 'stapled'], ['Pamphlet', 'stapled'], ['Magazine', 'stapled'],
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

test('skips the B&N scrape when every field it could supply is already filled', async () => {
  // B&N is a heavy scrape, so it is consulted only when it might fill a blank.
  // A book Open Library describes completely — title, author, publisher, date,
  // pages, cover and binding — leaves B&N nothing to add, so it is not called.
  const isbn = '9780593820247';
  const calls = [];
  const d = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({
      ol: {
        body: {
          [`ISBN:${isbn}`]: {
            title: 'DCC',
            authors: [{ name: 'Matt Dinniman' }],
            publishers: [{ name: 'Ace' }],
            publish_date: '2024',
            number_of_pages: 425,
            cover: { large: 'https://covers/OL1-L.jpg' },
          },
        },
      },
      olEdition: { body: { physical_format: 'Hardcover' } },
      bn: { text: bnGraph },
    }, calls),
  });
  assert.equal(d.format, 'hardback');
  assert.ok(!calls.some((u) => u.includes('barnesandnoble.com')), 'nothing left for B&N to fill, so no scrape');
});

test('consults B&N to fill any blank it can, not only the binding', async () => {
  // The new rule: B&N is asked whenever a field it carries is still blank —
  // here Open Library gives only a title and the binding, so author, publisher,
  // date, pages and cover are all still B&N's to supply.
  const isbn = '9780593820247';
  const calls = [];
  const d = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'Dungeon Crawler Carl' } } },
      olEdition: { body: { physical_format: 'Hardcover' } },   // binding known...
      bn: { text: bnGraph },
    }, calls),
  });
  assert.ok(calls.some((u) => u.includes('barnesandnoble.com')), '...but other fields are blank, so B&N is consulted');
  assert.equal(d.format, 'hardback', 'the binding Open Library gave is kept');
  assert.equal(d.authors, 'Matt Dinniman', 'and the missing author is filled from B&N');
  assert.equal(d.source, 'openlibrary', 'source still credits who answered first');
  assert.equal(d.title, 'Dungeon Crawler Carl', 'B&N does not overwrite what was already there');
});

test('consults B&N for the binding when neither primary source records one', async () => {
  const isbn = '9780593820247';
  const calls = [];
  const d = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'DCC' } } },   // no physical_format
      bn: { text: bnGraph },
    }, calls),
  });
  assert.ok(calls.some((u) => u.includes('barnesandnoble.com')), 'B&N consulted for the binding');
  assert.equal(d.format, 'hardback', 'binding filled from B&N');
  assert.equal(d.source, 'openlibrary', 'source still credits who supplied the metadata');
  assert.equal(d.title, 'DCC', 'B&N does not overwrite the primary metadata');
});

test('the binding fallback can be disabled, and a B&N failure stays harmless', async () => {
  const isbn = '9780593820247';
  const routes = { ol: { body: { [`ISBN:${isbn}`]: { title: 'DCC' } } }, bn: { text: bnGraph } };
  const calls = [];
  const off = await lookupIsbn(isbn, { apiKey: null, bindingFallback: false, fetch: fakeFetch(routes, calls) });
  assert.equal(off.format, '');
  assert.ok(!calls.some((u) => u.includes('barnesandnoble.com')), 'opted out, so no scrape');

  const broken = await lookupIsbn(isbn, {
    apiKey: null,
    fetch: fakeFetch({ ol: routes.ol, bn: { status: 503 } }),
  });
  assert.equal(broken.format, '', 'unavailable B&N leaves the binding empty');
  assert.equal(broken.title, 'DCC', 'and the lookup still succeeds');
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
    bindingFallback: false,   // otherwise B&N is consulted for the binding alone
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

// We contribute series tags back to Open Library, so we had better read them
// too. The field is free text and inconsistently numbered in the wild, hence a
// parser rather than a split.
test('parseSeries reads the numbering conventions Open Library actually contains', () => {
  const cases = [
    ['Discworld (1)', 'Discworld', 1],
    ['Discworld #1', 'Discworld', 1],
    ['Discworld -- 1', 'Discworld', 1],
    ['Discworld Vol. 1', 'Discworld', 1],
    ['Discworld, 12', 'Discworld', 12],
    ['Chronique du tueur de roi, #1', 'Chronique du tueur de roi', 1],
    ['The Discworld series', 'Discworld', null],
    ['Discworld series', 'Discworld', null],
    ['Discworld', 'Discworld', null],
  ];
  for (const [raw, title, order] of cases) {
    const got = parseSeries(raw);
    assert.equal(got?.title, title, `title of ${raw}`);
    assert.equal(got?.order, order, `order of ${raw}`);
  }
  assert.equal(parseSeries(''), null);
  assert.equal(parseSeries(null), null);
});

test('lookup returns the series and its position from the edition record', async () => {
  const isbn = '9780062225672';
  const calls = [];
  const data = await lookupIsbn(isbn, {
    apiKey: null,
    bindingFallback: false,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'The Colour of Magic' } } },
      olEdition: { body: { series: ['Discworld (1)'], works: [{ key: '/works/OL453657W' }] } },
    }, calls),
  });
  assert.equal(data.series, 'Discworld');
  assert.equal(data.series_order, 1);
  // The edition answered, so the work is not worth a second request.
  assert.equal(calls.some((u) => u.includes('/works/')), false, 'no needless work fetch');
});

test('lookup falls back to the work\'s series: tag, which carries no position', async () => {
  const isbn = '9780062225673';
  const data = await lookupIsbn(isbn, {
    apiKey: null,
    bindingFallback: false,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'Say Cheese and Die!' } } },
      olEdition: { body: { works: [{ key: '/works/OL72434W' }] } },   // no series here
      olWork: { body: { subjects: ['Juvenile fiction', 'series:Goosebumps'] } },
    }),
  });
  assert.equal(data.series, 'Goosebumps');
  assert.equal(data.series_order, null, 'the work tag never numbers the book');
});

test('a book in no series reports none, and a work miss is harmless', async () => {
  const isbn = '9780062225674';
  const data = await lookupIsbn(isbn, {
    apiKey: null,
    bindingFallback: false,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'Standalone' } } },
      olEdition: { body: { works: [{ key: '/works/OL999W' }] } },   // work 404s by default
    }),
  });
  assert.equal(data.series, '');
  assert.equal(data.series_order, null);
});

// A trimmed MODS record as lx2.loc.gov returns it (namespaced, nonSort title,
// inverted name with a separate date part, agent-style publisher).
const locMods = `<?xml version="1.0"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/"><zs:records><zs:record><zs:recordData>
<mods xmlns="http://www.loc.gov/mods/v3" version="3.8">
  <titleInfo><nonSort xml:space="preserve">The  </nonSort><title>catcher in the rye</title></titleInfo>
  <titleInfo type="alternative"><title>Not this one</title></titleInfo>
  <name type="personal" usage="primary"><namePart>Salinger, J. D. (Jerome David),</namePart><namePart type="date">1919-2010</namePart></name>
  <originInfo><place><placeTerm type="text">Boston, MA</placeTerm></place>
    <agent><namePart>Little, Brown and Company</namePart></agent>
    <dateIssued>2001</dateIssued></originInfo>
  <physicalDescription><form authority="marcform">print</form><extent>xi, 234 p. ; 24 cm</extent></physicalDescription>
  <subject><name><namePart>Caulfield, Holden</namePart></name></subject>
  <identifier type="isbn">9780316769174</identifier>
</mods></zs:recordData></zs:record></zs:records></zs:searchRetrieveResponse>`;

test('parseLocMods reads title, author, publisher, date, pages and height from MODS', () => {
  const d = parseLocMods(locMods);
  assert.equal(d.title, 'The catcher in the rye');
  assert.equal(d.authors, 'J. D. Salinger', 'inverted MARC name is flipped, dates and parentheticals dropped');
  assert.equal(d.publisher, 'Little, Brown and Company');
  assert.equal(d.published_date, '2001');
  assert.equal(d.page_count, 234, 'the arabic pagination, not the roman front matter');
  assert.equal(d.height_mm, 240);
  assert.equal(d.width_mm, null, 'MARC records only the height');
  assert.equal(d.format, '', 'the carrier is not a binding');
  assert.equal(d.cover_url, '', 'the catalog has no artwork');
});

test('parseLocMods returns null for an empty result and a non-MODS page', () => {
  assert.equal(parseLocMods('<zs:searchRetrieveResponse><zs:numberOfRecords>0</zs:numberOfRecords></zs:searchRetrieveResponse>'), null);
  assert.equal(parseLocMods('<!doctype html><html>captcha</html>'), null);
});

test('falls back to the Library of Congress when Open Library and Google Books miss', async () => {
  const calls = [];
  const d = await lookupIsbn('9780316769174', {
    apiKey: null,
    bindingFallback: false,   // keep B&N out of this test
    fetch: fakeFetch({
      ol: { status: 200, body: {} },
      gb: { status: 200, body: {} },
      loc: { text: locMods },
    }, calls),
  });
  assert.equal(d.source, 'loc');
  assert.equal(d.title, 'The catcher in the rye');
  assert.ok(calls.some((u) => u.includes('/lcdb?')), 'the SRU gateway was asked');
});

test('skips the Library of Congress when every field it could supply is already filled', async () => {
  const isbn = '9780593820247';
  const calls = [];
  await lookupIsbn(isbn, {
    apiKey: null,
    bindingFallback: false,
    fetch: fakeFetch({
      ol: {
        body: {
          [`ISBN:${isbn}`]: {
            title: 'DCC', authors: [{ name: 'Matt Dinniman' }], publishers: [{ name: 'Ace' }],
            publish_date: '2024', number_of_pages: 425, cover: { large: 'https://covers/OL1-L.jpg' },
            dimensions: '22.9 x 15.2 x 3.3 centimeters',
          },
        },
      },
      loc: { text: locMods },
    }, calls),
  });
  assert.ok(!calls.some((u) => u.includes('/lcdb?')), 'nothing left for the catalog to fill');
});

test('a Library of Congress outage is harmless: the lookup still answers from the rest', async () => {
  const isbn = '9780316769174';
  const d = await lookupIsbn(isbn, {
    apiKey: null,
    bindingFallback: false,
    fetch: fakeFetch({
      ol: { body: { [`ISBN:${isbn}`]: { title: 'Catcher', authors: [{ name: 'J. D. Salinger' }] } } },
      loc: { status: 500 },
    }),
  });
  assert.equal(d.source, 'openlibrary');
  assert.equal(d.title, 'Catcher');
});

test('parseIsbndbBook maps fields, binding, and ISBNdb’s oddly named dimensions', () => {
  const d = parseIsbndbBook({
    title: 'Oathbringer',
    authors: ['Brandon Sanderson'],
    publisher: 'Tor Books',
    date_published: '2017-11-14',
    pages: 1248,
    image: 'https://images.isbndb.com/covers/x.jpg',
    binding: 'Hardcover',
    // "Height" is the spine height, "Length" the cover width, "Width" the thickness.
    dimensions_structured: {
      height: { unit: 'inches', value: 9.45 },
      length: { unit: 'inches', value: 6.55 },
      width: { unit: 'inches', value: 2.4 },
    },
  });
  assert.equal(d.format, 'hardback');
  assert.equal(d.page_count, 1248);
  assert.equal(d.height_mm, 240);
  assert.equal(d.width_mm, 166);
  assert.equal(d.thickness_mm, 61);
  // The flat string works too, when the structured form is absent.
  const flat = parseIsbndbBook({ title: 'X', dimensions: 'Height: 9.25 Inches, Length: 6.25 Inches, Width: 1 Inches' });
  assert.deepEqual([flat.height_mm, flat.width_mm, flat.thickness_mm], [235, 159, 25]);
  assert.equal(parseIsbndbBook(undefined), null);
});

test('ISBNdb is consulted only when a key is supplied, and fills the blanks', async () => {
  const isbn = '9780765326355';
  const routes = {
    ol: { status: 200, body: {} },
    gb: { status: 200, body: {} },
    isbndb: { body: { book: { title: 'Oathbringer', authors: ['Brandon Sanderson'], binding: 'Hardcover' } } },
  };
  const without = [];
  assert.equal(await lookupIsbn(isbn, { apiKey: null, bindingFallback: false, fetch: fakeFetch(routes, without) }), null);
  assert.ok(!without.some((u) => u.includes('isbndb.com')), 'no key, no ISBNdb');

  const calls = [];
  const d = await lookupIsbn(isbn, { apiKey: null, isbndbKey: 'k', bindingFallback: false, fetch: fakeFetch(routes, calls) });
  assert.equal(d.source, 'isbndb');
  assert.equal(d.title, 'Oathbringer');
  assert.ok(calls.some((u) => u.includes('isbndb.com')), 'the key earns the consultation');
});

test('a rate-limited ISBNdb surfaces as RateLimitError when nothing else answers', async () => {
  await assert.rejects(
    lookupIsbn('9780765326355', {
      apiKey: null, isbndbKey: 'k', bindingFallback: false,
      fetch: fakeFetch({ ol: { status: 200, body: {} }, gb: { status: 200, body: {} }, isbndb: { status: 429 } }),
    }),
    RateLimitError,
  );
});
