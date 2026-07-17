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

const round1 = (n) => Math.round(n * 10) / 10;

// Parse strings like "9.1 x 6.1 x 1.2 inches" or "24.00 cm" into millimetres.
export function toMm(value) {
  if (!value) return null;
  const m = String(value).match(/([\d.]+)\s*(cm|mm|inch|inches|in|")?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const unit = (m[2] || 'cm').toLowerCase();
  if (unit === 'mm') return round1(n);
  if (unit === 'cm') return round1(n * 10);
  return round1(n * 25.4); // inches
}

async function fetchOpenLibrary(isbn, doFetch) {
  const r = await doFetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
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
    height_mm: toMm(d.height), width_mm: toMm(d.width), thickness_mm: toMm(d.thickness),
  };
}

// Look up an ISBN. Returns merged metadata (Open Library preferred, Google Books
// filling gaps), null if neither source has the book, or throws RateLimitError
// if a source was throttled and nothing else answered.
export async function lookupIsbn(isbn, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.GOOGLE_BOOKS_API_KEY;

  const [openlib, google] = await Promise.allSettled([
    fetchOpenLibrary(isbn, doFetch),
    fetchGoogleBooks(isbn, doFetch, apiKey),
  ]);
  const ol = openlib.status === 'fulfilled' ? openlib.value : null;
  const gb = google.status === 'fulfilled' ? google.value : null;

  if (ol || gb) {
    const first = (...vals) => vals.find((v) => v != null && v !== '') ?? '';
    return {
      isbn,
      title: first(ol?.title, gb?.title),
      authors: first(ol?.authors, gb?.authors),
      publisher: first(ol?.publisher, gb?.publisher),
      published_date: first(ol?.published_date, gb?.published_date),
      page_count: first(ol?.page_count, gb?.page_count) || null,
      cover_url: first(ol?.cover_url, gb?.cover_url),
      height_mm: ol?.height_mm ?? gb?.height_mm ?? null,
      width_mm: ol?.width_mm ?? gb?.width_mm ?? null,
      thickness_mm: ol?.thickness_mm ?? gb?.thickness_mm ?? null,
      source: ol ? 'openlibrary' : 'googlebooks',
    };
  }

  // Nothing found — if a source was rate-limited, that's why (not a missing book).
  const throttled = [openlib, google].some(
    (r) => r.status === 'rejected' && r.reason instanceof RateLimitError,
  );
  if (throttled) throw new RateLimitError();
  return null;
}
