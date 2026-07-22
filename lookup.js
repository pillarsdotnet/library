// ISBN metadata lookup: merges Open Library and Google Books, including physical
// size. fetch and the Google Books API key are injectable so this is unit-testable.

// Thrown when a source refuses due to rate limiting / quota, so the caller can
// tell "temporarily throttled" apart from "book genuinely not found".
export class RateLimitError extends Error {
  constructor(message = 'metadata source rate-limited') {
    super(message);
    this.name = 'RateLimitError';
  }
}

// Source hosts default to the real services, but are overridable so a mirror —
// or a test stub — can stand in. OPENLIBRARY_BASE is shared with the
// contribution module, which points at the same Open Library.
const OL_BASE = process.env.OPENLIBRARY_BASE || 'https://openlibrary.org';
const GB_BASE = process.env.GOOGLE_BOOKS_BASE || 'https://www.googleapis.com';
const BN_BASE = process.env.BARNESNOBLE_BASE || 'https://www.barnesandnoble.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transient server errors worth retrying (a freshly-enabled Google API key
// returns 503 while it warms up). 429 is NOT here — that's a real rate limit.
const RETRYABLE_STATUS = new Set([502, 503, 504]);

// Wrap a fetch so transient 5xx responses (and network errors) are retried a few
// times with linear backoff. Definitive results (2xx/4xx) return immediately.
function withRetry(doFetch, retries, delayMs) {
  return async (url, opts) => {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await doFetch(url, opts);
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(delayMs * attempt);
        continue;
      }
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= retries) return res;
      await sleep(delayMs * attempt);
    }
  };
}

// Parse strings like "9.1 x 6.1 x 1.2 inches" or "24.00 cm" into millimetres.
export function toMm(value) {
  if (!value) return null;
  const m = String(value).match(/([\d.]+)\s*(cm|mm|inch|inches|in|")?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const unit = (m[2] || 'cm').toLowerCase();
  // Dimensions are stored as whole millimetres — finer precision isn't useful.
  if (unit === 'mm') return Math.round(n);
  if (unit === 'cm') return Math.round(n * 10);
  return Math.round(n * 25.4); // inches
}

// Map a binding as described by Open Library ("Hardcover", "Mass Market
// Paperback") or schema.org ("https://schema.org/Hardcover") onto the formats
// the app stores. Unknown bindings return '' so nothing is guessed.
export function normalizeFormat(value) {
  const s = String(value || '').toLowerCase();
  if (!s) return '';
  if (/audio|cd|cassette/.test(s)) return 'audiobook';
  if (/ebook|e-book|kindle|epub|digital/.test(s)) return 'ebook';
  if (/hardcover|hardback|hardbound|casebound|library binding/.test(s)) return 'hardback';
  if (/paperback|softcover|soft cover|paper back|trade pbk|pbk|mass market/.test(s)) return 'paperback';
  return '';
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&rsquo;/g, '’')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// Parse a Barnes & Noble product page. Prefers the schema.org Product JSON-LD
// (stable structured data); author isn't in it, so it's read from the
// contributor link. Exported for testing. Returns null if it's not a product page.
// schema.org values arrive as a string, an object with a name, or a list of either.
// B&N sometimes puts a bare contributor URL where a name belongs, so ignore URLs.
const isUrl = (s) => /^https?:\/\//i.test(String(s));
function schemaName(v) {
  if (!v) return '';
  if (typeof v === 'string') return isUrl(v) ? '' : decodeEntities(v);
  if (Array.isArray(v)) return v.map(schemaName).filter(Boolean).join(', ');
  return v.name ? schemaName(v.name) : '';
}

// Last resort for an author given only as .../contributor/matt-dinniman
function nameFromUrl(u) {
  const path = String(u).split(/[?#]/)[0].replace(/\/+$/, '');   // drop query/hash only
  const slug = path.split('/').filter(Boolean).pop() || '';
  return slug.split('-').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Collect every object in a JSON-LD document, following @graph and hasVariant.
function flattenJsonLd(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => flattenJsonLd(n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') flattenJsonLd(v, out);
  }
  return out;
}

export function parseBarnesNoble(html, isbn) {
  const nodes = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { flattenJsonLd(JSON.parse(m[1].trim()), nodes); } catch { /* skip malformed block */ }
  }
  // B&N now nests a Product per format inside a ProductGroup, under @graph.
  const named = nodes.filter((n) => /^(Product|ProductGroup|Book)$/.test(n['@type'] || '') && n.name);
  if (!named.length) return null;

  const group = named.find((n) => n['@type'] === 'ProductGroup') || named[0];
  // Prefer the edition actually asked for: its offer URL / image carries the EAN.
  const edition = isbn
    ? named.find((n) => n !== group && JSON.stringify(n.offers ?? '').includes(isbn))
      || named.find((n) => n !== group && String(n.image ?? '').includes(isbn))
    : null;
  const pick = (key) => edition?.[key] ?? group[key];

  // Author: the schema value, else the visible contributor link, else its slug.
  let authors = schemaName(group.author) || schemaName(edition?.author);
  if (!authors) {
    const linked = html.match(/href=["'](?:\/authors\/|\/b\/contributor\/)[^"']+["'][^>]*>\s*([^<]+?)\s*<\/a>/i);
    if (linked) authors = decodeEntities(linked[1]);
  }
  if (!authors) {
    const raw = [group.author, edition?.author].flat().find((a) => typeof a === 'string' && isUrl(a));
    if (raw) authors = nameFromUrl(raw);
  }
  const image = pick('image');

  return {
    title: decodeEntities(group.name),
    authors,
    publisher: schemaName(group.publisher) || schemaName(group.brand) || schemaName(edition?.publisher),
    published_date: pick('datePublished') || '',
    format: normalizeFormat(pick('bookFormat')),
    page_count: Number(pick('numberOfPages')) || null,
    cover_url: (Array.isArray(image) ? image[0] : image) || '',
    height_mm: null, width_mm: null, thickness_mm: null,
  };
}

// Barnes & Noble has no API; scrape the public product page as a last resort
// (B&N-exclusive editions often aren't in Open Library or Google Books). This is
// best-effort and tolerant: any failure just yields null.
async function fetchBarnesNoble(isbn, doFetch) {
  try {
    const r = await doFetch(`${BN_BASE}/w/?ean=${isbn}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return parseBarnesNoble(await r.text(), isbn);
  } catch {
    return null; // network error, timeout, or bot block — don't break the lookup
  }
}

// Open Library keeps a series in two places, and neither is structured. An
// edition carries a free-text `series` array whose numbering follows no
// convention anyone agreed on — "Discworld (1)", "Discworld #1", "Discworld --
// 1", "Discworld Vol. 1" and plain "Discworld series" all occur in the wild —
// while a work carries a `series:Name` subject tag, which is the form the
// contributors' guide sanctions and which holds no number at all.
//
// So: take the name from either, and take a position only when the edition
// string offers one. A position we invent is worse than none.
export function parseSeries(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  let order = null;
  const numbered = [
    /^(.*?)[\s,]*\((\d+)\)$/,           // Discworld (1)
    /^(.*?)[\s,]*#\s*(\d+)$/,           // Discworld #1
    /^(.*?)\s*[-–—]{1,2}\s*(\d+)$/,     // Discworld -- 1
    /^(.*?)[\s,]*(?:vol|volume|bk|book|no|nr)\.?\s*(\d+)$/i, // Discworld Vol. 1
    /^(.*?),\s*(\d+)$/,                 // Discworld, 1
  ];
  for (const re of numbered) {
    const m = re.exec(s);
    if (m && m[1].trim()) { s = m[1].trim(); order = Number(m[2]); break; }
  }

  // "The Discworld series" and "Discworld series" both name the same series as
  // "Discworld"; the decoration is not part of the name.
  s = s.replace(/\s+series$/i, '').replace(/^the\s+/i, '').replace(/[\s,;:-]+$/, '').trim();
  if (!s) return null;
  return { title: s, order: Number.isFinite(order) && order > 0 ? order : null };
}

// The `series:` tag a work carries in its subjects, per the contributors' FAQ.
function seriesFromWork(work) {
  const tag = (work?.subjects || []).find((x) => /^series:/i.test(String(x)));
  return tag ? parseSeries(String(tag).replace(/^series:/i, '')) : null;
}

async function fetchOpenLibrary(isbn, doFetch) {
  // The bulk endpoint omits the binding, so ask the edition record for it too.
  // Runs alongside, so it costs no extra wall time, and is optional.
  const [r, edition] = await Promise.all([
    doFetch(`${OL_BASE}/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`),
    doFetch(`${OL_BASE}/isbn/${isbn}.json`).then((x) => (x.ok ? x.json() : null)).catch(() => null),
  ]);
  if (r.status === 429) throw new RateLimitError('Open Library rate-limited');
  if (!r.ok) return null;
  const data = (await r.json())[`ISBN:${isbn}`];
  if (!data) return null;

  // e.g. "20.3 x 13.3 x 2.5 centimeters"
  let h = null, w = null, t = null;
  if (data.dimensions) {
    const parts = String(data.dimensions).split(/x|×/);
    const unit = /inch/i.test(data.dimensions) ? 'inch' : /mm/i.test(data.dimensions) ? 'mm' : 'cm';
    const nums = parts.map((p) => toMm(p.trim().replace(/[a-z"]/gi, '') + ' ' + unit)).filter((n) => n != null);
    [h, w, t] = [nums[0] ?? null, nums[1] ?? null, nums[2] ?? null];
  }
  // The edition's own series string first; it is the only one that can carry a
  // position. Only when it has none is the work worth a second request — the
  // tag there names the series but never numbers it.
  let series = parseSeries(edition?.series?.[0]);
  if (!series) {
    const workKey = edition?.works?.[0]?.key;
    if (/^\/works\/OL\d+W$/.test(workKey || '')) {
      const work = await doFetch(`${OL_BASE}${workKey}.json`)
        .then((x) => (x.ok ? x.json() : null))
        .catch(() => null);
      series = seriesFromWork(work);
    }
  }

  return {
    title: data.title,
    authors: (data.authors || []).map((a) => a.name).join(', '),
    publisher: (data.publishers || []).map((p) => p.name).join(', '),
    published_date: data.publish_date,
    page_count: data.number_of_pages || null,
    cover_url: data.cover?.large || data.cover?.medium || data.cover?.small || '',
    format: normalizeFormat(edition?.physical_format),
    height_mm: h, width_mm: w, thickness_mm: t,
    series: series?.title || '',
    series_order: series?.order ?? null,
  };
}

async function fetchGoogleBooks(isbn, doFetch, apiKey) {
  let url = `${GB_BASE}/books/v1/volumes?q=isbn:${isbn}&country=US`;
  if (apiKey) url += `&key=${apiKey}`;
  const r = await doFetch(url);
  // Keyless Google Books has a tiny shared daily quota; surface that distinctly.
  if (r.status === 429) throw new RateLimitError('Google Books rate-limited');
  if (!r.ok) return null;
  const vol = (await r.json()).items?.[0]?.volumeInfo;
  if (!vol) return null;
  const d = vol.dimensions || {};
  return {
    title: vol.title + (vol.subtitle ? `: ${vol.subtitle}` : ''),
    authors: (vol.authors || []).join(', '),
    publisher: vol.publisher || '',
    published_date: vol.publishedDate || '',
    page_count: vol.pageCount || null,
    cover_url: (vol.imageLinks?.thumbnail || '').replace('http://', 'https://'),
    format: '',   // Google Books doesn't publish the binding
    height_mm: toMm(d.height), width_mm: toMm(d.width), thickness_mm: toMm(d.thickness),
  };
}

// A value counts as present only if it actually says something: an empty string,
// a null, or a zero page-count / dimension is a blank to be filled.
const isFilled = (v) => v !== null && v !== undefined && v !== '' && v !== 0;
const allFilled = (obj, keys) => keys.every((k) => isFilled(obj[k]));
// Copy over only the blanks. A source that returns '' or null for a field it
// does not carry (Google Books has no binding; Barnes & Noble has no
// dimensions) simply fills nothing there — capability enforces itself.
function fillBlanks(target, src) {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    if (isFilled(v) && !isFilled(target[k])) target[k] = v;
  }
}

// The fields each source can actually supply, intersected with what the app
// stores — so a source is consulted only when it could fill a field still blank.
// Google Books carries no binding; Barnes & Noble carries no dimensions; only
// Open Library carries a usable series, so no fallback is asked for one.
const GOOGLE_FIELDS = ['title', 'authors', 'publisher', 'published_date',
  'page_count', 'cover_url', 'height_mm', 'width_mm', 'thickness_mm'];
const BN_FIELDS = ['title', 'authors', 'publisher', 'published_date',
  'page_count', 'cover_url', 'format'];

// Look up an ISBN, consulting sources in order and stopping as soon as the
// answer is complete: Open Library first, then Google Books only if a field it
// could supply is still blank, then Barnes & Noble on the same condition. Each
// source fills only the blanks the previous ones left. Returns the merged
// record, null if no source has the book, or throws RateLimitError if a source
// was throttled and nothing else answered.
export async function lookupIsbn(isbn, opts = {}) {
  const baseFetch = opts.fetch || globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.GOOGLE_BOOKS_API_KEY;
  // Retry transient 5xx on the JSON APIs (smooths Google's new-key warm-up 503s).
  const doFetch = withRetry(baseFetch, opts.retries ?? 3, opts.retryDelayMs ?? 250);

  const result = {
    isbn, title: '', authors: '', publisher: '', published_date: '',
    page_count: null, cover_url: '', format: '',
    height_mm: null, width_mm: null, thickness_mm: null,
    series: '', series_order: null,
  };
  let sourceName = null;   // credited to the first source that answered
  let throttled = false;

  const consult = async (name, run) => {
    let data = null;
    try { data = await run(); } catch (err) {
      if (err instanceof RateLimitError) { throttled = true; return; }
      throw err;
    }
    if (data) { if (!sourceName) sourceName = name; fillBlanks(result, data); }
  };

  // 1. Open Library.
  await consult('openlibrary', () => fetchOpenLibrary(isbn, doFetch));

  // 2-3. Google Books, only if it could fill something still blank.
  if (!allFilled(result, GOOGLE_FIELDS)) {
    await consult('googlebooks', () => fetchGoogleBooks(isbn, doFetch, apiKey));
  }

  // 4-5. Barnes & Noble, likewise — a heavy scrape, so only when it might help.
  // Uses baseFetch (it has its own single-shot timeout, no retry). Opt out with
  // { bindingFallback: false }.
  if (opts.bindingFallback !== false && !allFilled(result, BN_FIELDS)) {
    await consult('barnesnoble', () => fetchBarnesNoble(isbn, baseFetch));
  }

  if (!sourceName) {
    // Nothing found — if a source was rate-limited, that's why, not a missing book.
    if (throttled) throw new RateLimitError();
    return null;
  }
  result.source = sourceName;
  return result;
}
