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
    const r = await doFetch(`https://www.barnesandnoble.com/w/?ean=${isbn}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return parseBarnesNoble(await r.text(), isbn);
  } catch {
    return null; // network error, timeout, or bot block — don't break the lookup
  }
}

async function fetchOpenLibrary(isbn, doFetch) {
  // The bulk endpoint omits the binding, so ask the edition record for it too.
  // Runs alongside, so it costs no extra wall time, and is optional.
  const [r, edition] = await Promise.all([
    doFetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`),
    doFetch(`https://openlibrary.org/isbn/${isbn}.json`).then((x) => (x.ok ? x.json() : null)).catch(() => null),
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
  return {
    title: data.title,
    authors: (data.authors || []).map((a) => a.name).join(', '),
    publisher: (data.publishers || []).map((p) => p.name).join(', '),
    published_date: data.publish_date,
    page_count: data.number_of_pages || null,
    cover_url: data.cover?.large || data.cover?.medium || data.cover?.small || '',
    format: normalizeFormat(edition?.physical_format),
    height_mm: h, width_mm: w, thickness_mm: t,
  };
}

async function fetchGoogleBooks(isbn, doFetch, apiKey) {
  let url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&country=US`;
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

// Look up an ISBN. Returns merged metadata (Open Library preferred, Google Books
// filling gaps), null if neither source has the book, or throws RateLimitError
// if a source was throttled and nothing else answered.
export async function lookupIsbn(isbn, opts = {}) {
  const baseFetch = opts.fetch || globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.GOOGLE_BOOKS_API_KEY;
  // Retry transient 5xx on the JSON APIs (smooths Google's new-key warm-up 503s).
  const doFetch = withRetry(baseFetch, opts.retries ?? 3, opts.retryDelayMs ?? 250);

  const [openlib, google] = await Promise.allSettled([
    fetchOpenLibrary(isbn, doFetch),
    fetchGoogleBooks(isbn, doFetch, apiKey),
  ]);
  const ol = openlib.status === 'fulfilled' ? openlib.value : null;
  const gb = google.status === 'fulfilled' ? google.value : null;

  if (ol || gb) {
    const first = (...vals) => vals.find((v) => v != null && v !== '') ?? '';
    let format = first(ol?.format, gb?.format);
    // Neither primary source records the binding for roughly half of editions.
    // Barnes & Noble publishes it per edition, so ask them just for that. The
    // scrape is heavy, hence only when it is the missing piece, and any failure
    // simply leaves the field empty. Opt out with { bindingFallback: false }.
    if (!format && opts.bindingFallback !== false) {
      format = (await fetchBarnesNoble(isbn, baseFetch))?.format || '';
    }
    return {
      isbn,
      title: first(ol?.title, gb?.title),
      authors: first(ol?.authors, gb?.authors),
      publisher: first(ol?.publisher, gb?.publisher),
      published_date: first(ol?.published_date, gb?.published_date),
      page_count: first(ol?.page_count, gb?.page_count) || null,
      cover_url: first(ol?.cover_url, gb?.cover_url),
      format,
      height_mm: ol?.height_mm ?? gb?.height_mm ?? null,
      width_mm: ol?.width_mm ?? gb?.width_mm ?? null,
      thickness_mm: ol?.thickness_mm ?? gb?.thickness_mm ?? null,
      source: ol ? 'openlibrary' : 'googlebooks',
    };
  }

  // Last-resort fallback: scrape Barnes & Noble. Runs only when the primary
  // sources have nothing, so it also covers the case where Google was throttled.
  // Uses baseFetch (it has its own single-shot timeout, no retry needed).
  const bn = await fetchBarnesNoble(isbn, baseFetch);
  if (bn) return { isbn, ...bn, source: 'barnesnoble' };

  // Still nothing — if a source was rate-limited, that's why (not a missing book).
  const throttled = [openlib, google].some(
    (r) => r.status === 'rejected' && r.reason instanceof RateLimitError,
  );
  if (throttled) throw new RateLimitError();
  return null;
}
