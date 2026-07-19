import { unzipSync, strFromU8 } from 'fflate';

const decode = (s) => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/\s+/g, ' ').trim();

// "Last, First" -> "First Last" (only for a single simple comma).
const flipName = (n) => {
  const m = n.match(/^([^,]+),\s*(.+)$/);
  return (m && !m[2].includes(',')) ? `${m[2].trim()} ${m[1].trim()}` : n;
};

// Resolve a manifest href relative to the OPF's directory, handling ./ and ../
function resolvePath(dir, href) {
  const stack = [];
  for (const part of (dir + href).split('/')) {
    if (part === '..') stack.pop();
    else if (part !== '.' && part !== '') stack.push(part);
  }
  return stack.join('/');
}

function findCover(opf, opfDir, files) {
  const attr = (tag, name) => (tag.match(new RegExp(`${name}="([^"]*)"`, 'i')) || [])[1] || '';
  const manifest = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => ({
    id: attr(m[0], 'id'), href: attr(m[0], 'href'),
    type: attr(m[0], 'media-type'), props: attr(m[0], 'properties'),
  }));
  const metaId = (opf.match(/<meta[^>]*name="cover"[^>]*content="([^"]+)"/i)
    || opf.match(/<meta[^>]*content="([^"]+)"[^>]*name="cover"/i) || [])[1];

  let item = metaId && manifest.find((m) => m.id === metaId && /image\//i.test(m.type));
  item = item || manifest.find((m) => /cover-image/i.test(m.props));
  item = item || manifest.find((m) => /image\//i.test(m.type) && /cover/i.test(`${m.id} ${m.href}`));
  if (!item || !item.href) return null;

  const data = files[resolvePath(opfDir, decodeURIComponent(item.href))];
  return data ? { data: Buffer.from(data), mime: item.type || 'image/jpeg' } : null;
}

// Parse an EPUB buffer into catalogue metadata + raw cover bytes. Best-effort
// and tolerant; throws only if it isn't a readable EPUB with an OPF.
export function parseEpub(buffer) {
  const files = unzipSync(new Uint8Array(buffer));

  const container = files['META-INF/container.xml'] ? strFromU8(files['META-INF/container.xml']) : '';
  const opfPath = (container.match(/full-path="([^"]+)"/i) || [])[1];
  if (!opfPath || !files[opfPath]) throw new Error('not an EPUB (no OPF package found)');
  const opf = strFromU8(files[opfPath]);
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const tags = (name) => [...opf.matchAll(new RegExp(`<dc:${name}[^>]*>([^<]+)</dc:${name}>`, 'gi'))]
    .map((m) => decode(m[1])).filter(Boolean);

  let isbn = '';
  const ids = tags('identifier');
  for (const raw of ids) {
    const s = raw.replace(/^urn:isbn:/i, '').replace(/isbn[:\s]*/i, '').replace(/[-\s]/g, '');
    if (/^\d{13}$/.test(s) && /^97[89]/.test(s)) { isbn = s; break; }
  }
  if (!isbn) for (const raw of ids) { const s = raw.replace(/[-\s]/g, ''); if (/^\d{9}[\dXx]$/.test(s)) { isbn = s.toUpperCase(); break; } }

  const date = (tags('date')[0] || '').match(/\d{4}/);
  return {
    title: tags('title')[0] || '',
    authors: tags('creator').map(flipName).join(', '),
    isbn,
    publisher: tags('publisher')[0] || '',
    published_date: date ? date[0] : '',
    cover: findCover(opf, opfDir, files),
  };
}
