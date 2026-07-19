import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseEpub } from '../epub.js';

// Build a minimal in-memory EPUB (zip) for testing.
function makeEpub({
  title, creator, identifier, publisher, date,
  coverHref = 'images/cover.jpg', includeCover = true,
} = {}) {
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${title}</dc:title>
    <dc:creator opf:role="aut">${creator}</dc:creator>
    <dc:identifier id="bookid">${identifier}</dc:identifier>
    <dc:publisher>${publisher}</dc:publisher>
    <dc:date>${date}</dc:date>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="${coverHref}" media-type="image/jpeg"/>
  </manifest>
</package>`;
  const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const entries = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
  };
  if (includeCover) entries[`OEBPS/${coverHref}`] = strToU8('JPEGDATA');
  return Buffer.from(zipSync(entries));
}

test('parseEpub extracts title, author (flipped), ISBN, publisher, year, and cover', () => {
  const m = parseEpub(makeEpub({
    title: 'Your Hate Mail Will Be Graded',
    creator: 'Scalzi, John',
    identifier: '978-1-4299-6771-6',
    publisher: 'Tom Doherty Associates',
    date: '2008-12-01',
  }));
  assert.equal(m.title, 'Your Hate Mail Will Be Graded');
  assert.equal(m.authors, 'John Scalzi'); // "Last, First" -> "First Last"
  assert.equal(m.isbn, '9781429967716'); // hyphens stripped
  assert.equal(m.publisher, 'Tom Doherty Associates');
  assert.equal(m.published_date, '2008');
  assert.ok(m.cover && m.cover.data.length > 0, 'cover bytes extracted');
});

test('parseEpub decodes XML entities and ignores non-ISBN identifiers', () => {
  const m = parseEpub(makeEpub({
    title: 'Kawaii Caf&#233; &amp; Bubble Tea', creator: 'Jane Doe',
    identifier: 'uuid:abc-123', publisher: 'P', date: '2023',
  }));
  assert.equal(m.title, 'Kawaii Café & Bubble Tea');
  assert.equal(m.isbn, '');
});

test('parseEpub tolerates a missing cover file', () => {
  const m = parseEpub(makeEpub({ title: 'No Cover', creator: 'A B', identifier: 'x', publisher: '', date: '', includeCover: false }));
  assert.equal(m.title, 'No Cover');
  assert.equal(m.cover, null);
});

test('parseEpub throws on a non-EPUB buffer', () => {
  assert.throws(() => parseEpub(Buffer.from(zipSync({ 'random.txt': strToU8('hi') }))), /EPUB|OPF/i);
});
