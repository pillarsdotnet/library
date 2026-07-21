// Contributing back to Open Library.
//
// The app takes a great deal from Open Library, and a shelf of hand-measured
// physical copies is exactly what Open Library is short of. This module works
// out what an edition record is missing that we can answer, and — once a human
// has approved it — sends it.
//
// Two rules run through all of it:
//
//   1. Only ever fill a blank. If Open Library records a value we never touch
//      it, however wrong it looks. Someone chose that value, they may have had
//      the book in front of them, and a disagreement is not a correction. The
//      one thing worse than a gap in a public catalogue is a silent overwrite.
//   2. Never send without approval. Proposals go in a queue and wait.
//
// Page count deserves its own note, because it is the field where "missing"
// and "different" are most easily confused. Editions legitimately differ on
// what counts: front matter, plates, unnumbered endmatter. This app's
// convention is the highest *explicitly numbered* page, disregarding unnumbered
// ones — so every page-count contribution says so in its edit comment, and a
// count Open Library already holds is left alone even when ours differs.

const OL = process.env.OPENLIBRARY_BASE || 'https://openlibrary.org';

// Fields we are willing to offer, in the order a reviewer sees them. `book` is
// a row from our books table; `ol` is a parsed Open Library edition record.
//
// `has` answers "does Open Library already say something here?" — a blank, a
// zero, an empty array and a missing key all count as missing, and anything
// else counts as present.
// Series is the odd one out, and worth explaining. Open Library has two places
// a series could go, and the contributors' guide picks one:
//
//   "If all editions of a work belongs to a series (usually this is a literary
//    series created by the author (i.e. Goosebumps) versus a publisher's
//    collection (i.e. Everyman's Library)) you may add a special series tag
//    formatted as [series:series_name]."
//
// That tag lives on the *work*, not the edition, and the brackets are only the
// edit form's syntax — what is stored is a plain subject string, `series:Name`,
// which is what drives /subjects/series:name pages. So this one field is edited
// through a different record from every other field here, hence `target`.
//
// Note what the sanctioned form cannot carry: a position. There is nowhere in
// `series:Name` to say "book 4", so the series tag contributes the membership
// only. Position is deliberately not sent — see the README.
const SERIES_TAG = /^series:/i;

const FIELDS = [
  {
    name: 'series',
    label: 'Series',
    target: 'work',
    has: (work) => (work.subjects || []).some((s) => SERIES_TAG.test(s)),
    ours: (book) => (book.series_title ? `series:${book.series_title}` : null),
    // A tag is appended to the subjects it shares a record with, never replacing
    // them: subjects are a communal pile, and we are adding one stone to it.
    apply: (work, value) => ({ ...work, subjects: [...(work.subjects || []), value] }),
    comment: 'Add a series tag for this work.',
  },
  {
    name: 'cover',
    label: 'Cover image',
    has: (ol) => Array.isArray(ol.covers) && ol.covers.some((c) => c > 0),
    ours: (book) => (book.cover_url ? 'cover photo' : null),
    comment: 'Add a cover photograph of this edition.',
  },
  {
    name: 'physical_dimensions',
    label: 'Dimensions',
    has: (ol) => !!ol.physical_dimensions,
    ours: (book) => {
      const { height_mm: h, width_mm: w, thickness_mm: t } = book;
      if (!h || !w || !t) return null;   // partial dimensions are not worth publishing
      const cm = (mm) => Math.round(mm) / 10;
      return `${cm(h)} x ${cm(w)} x ${cm(t)} centimeters`;
    },
    comment: 'Add physical dimensions measured from the book.',
  },
  {
    name: 'physical_format',
    label: 'Binding',
    has: (ol) => !!ol.physical_format,
    // Our vocabulary is already Open Library's for the physical bindings. The
    // digital ones describe a file, not an edition of a printed book, so they
    // are never offered.
    ours: (book) => (['hardback', 'paperback'].includes(book.format) ? book.format : null),
    comment: 'Add the binding, taken from the copy in hand.',
  },
  {
    name: 'number_of_pages',
    label: 'Page count',
    has: (ol) => Number.isFinite(ol.number_of_pages) && ol.number_of_pages > 0,
    ours: (book) => (book.page_count > 0 ? book.page_count : null),
    comment:
      'Add a page count: the highest explicitly numbered page, disregarding '
      + 'unnumbered pages.',
  },
];

export const FIELD_LABELS = Object.fromEntries([...FIELDS.map((f) => [f.name, f.label]), ['import', 'New record']]);
export const FIELD_COMMENTS = Object.fromEntries(FIELDS.map((f) => [f.name, f.comment]));

// Fetch the Open Library edition for an ISBN, and the work behind it. Returns
// { olid, record, workOlid, work } or null when Open Library has no edition to
// contribute to — we add to records, we do not create them, so an unknown ISBN
// is simply not our business here. The work may be absent; only the series tag
// needs it, and that proposal is simply not offered without one.
export async function fetchEdition(isbn, doFetch = globalThis.fetch) {
  if (!isbn) return null;
  const r = await doFetch(`${OL}/isbn/${encodeURIComponent(isbn)}.json`, {
    headers: { Accept: 'application/json' },
    redirect: 'follow',
  });
  if (!r.ok) return null;
  const record = await r.json();
  const olid = String(record.key || '').split('/').pop();
  if (!/^OL\d+M$/.test(olid)) return null;

  let work = null, workOlid = null;
  const workKey = record.works?.[0]?.key;
  if (/^\/works\/OL\d+W$/.test(workKey || '')) {
    workOlid = workKey.split('/').pop();
    try {
      const wr = await doFetch(`${OL}${workKey}.json`, { headers: { Accept: 'application/json' } });
      work = wr.ok ? await wr.json() : null;
    } catch { work = null; }
  }
  return { olid, record, workOlid, work };
}

// What could we add? Returns one proposal per fillable blank, across the
// edition and the work behind it.
export function proposalsFor(book, record, work = null) {
  const out = [];
  for (const f of FIELDS) {
    const onWork = f.target === 'work';
    const target = onWork ? work : record;
    if (!target) continue;               // no work fetched: nothing to say about it
    if (f.has(target)) continue;         // rule 1: only ever fill a blank
    const value = f.ours(book);
    if (value == null || value === '') continue;
    out.push({
      field: f.name, label: f.label, value: String(value),
      comment: f.comment, target: f.target || 'edition',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Importing books Open Library has never heard of.
//
// This is a different kind of act from everything above. The rest of this file
// fills blanks in records other people made; this creates records. A bad edit
// is a wrong value in one field, a bad import is a duplicate or a phantom book
// in a public catalogue, and duplicates can only be merged by librarians.
//
// Hence three brakes:
//   1. Off unless OPENLIBRARY_ALLOW_IMPORT is set. The bot application filed
//      for this account says it creates no records; until that is renegotiated,
//      the switch stays off and nothing can be queued.
//   2. Proposed only when Open Library genuinely has no edition for the ISBN.
//   3. Every import is previewed first (`?preview=true` parses, validates and
//      runs Open Library's own duplicate matching without saving), and what the
//      preview says is what the reviewer approves.
// ---------------------------------------------------------------------------

export function importAllowed() {
  return process.env.OPENLIBRARY_ALLOW_IMPORT === 'true';
}

// Open Library accepts either a "complete" record (title, authors, publishers,
// publish_date) or one carrying a strong identifier (title + ISBN/LCCN); both
// need source_records. Build the fullest record the book supports, and return
// null when it satisfies neither shape — an import too thin to identify is
// exactly the kind that becomes someone else's cleanup.
export function importPayload(book, prefix = process.env.OPENLIBRARY_SOURCE_PREFIX) {
  const isbn = String(book.isbn || '').replace(/[^0-9Xx]/g, '');
  const title = String(book.title || '').trim();
  if (!title || !isbn) return null;
  if (!prefix) return null;      // the source prefix is assigned by Open Library

  const rec = {
    title,
    source_records: [`${prefix}:${isbn}`],
    [isbn.length === 10 ? 'isbn_10' : 'isbn_13']: [isbn],
  };
  const authors = String(book.authors || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (authors.length) rec.authors = authors.map((name) => ({ name }));
  if (book.publisher) rec.publishers = [String(book.publisher).trim()];
  if (book.published_date) rec.publish_date = String(book.published_date).trim();
  if (book.page_count > 0) rec.number_of_pages = book.page_count;
  if (['hardback', 'paperback'].includes(book.format)) rec.physical_format = book.format;

  const dims = FIELDS.find((f) => f.name === 'physical_dimensions').ours(book);
  if (dims) rec.physical_dimensions = dims;
  return rec;
}

// One request, either a rehearsal or the real thing. The reply names what was
// created or matched: { edition: { key, status }, work: { key, status } }.
export async function sendImport(payload, cookie, { preview = false } = {}, doFetch = globalThis.fetch) {
  if (!importAllowed()) throw new Error('importing is switched off (OPENLIBRARY_ALLOW_IMPORT)');
  const r = await doFetch(`${OL}/api/import${preview ? '?preview=true' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let reply = null;
  try { reply = JSON.parse(text); } catch { /* not JSON: keep the raw text below */ }
  if (!r.ok || reply?.success === false) {
    throw new Error(reply?.error || `Open Library refused the import (${r.status}): ${text.slice(0, 200)}`);
  }
  return reply;
}

// ---------------------------------------------------------------------------
// Sending. Everything below needs credentials; see the README for getting them.
// ---------------------------------------------------------------------------

export function haveCredentials() {
  return !!(process.env.OPENLIBRARY_ACCESS_KEY && process.env.OPENLIBRARY_SECRET_KEY);
}

// Log in with Internet Archive S3 keys and keep the session cookie. Open
// Library hands back a cookie rather than a bearer token, so the cookie is the
// credential for every write that follows.
export async function login(doFetch = globalThis.fetch) {
  const access = process.env.OPENLIBRARY_ACCESS_KEY;
  const secret = process.env.OPENLIBRARY_SECRET_KEY;
  if (!access || !secret) throw new Error('Open Library credentials are not configured');
  const r = await doFetch(`${OL}/account/login.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access, secret }),
  });
  const cookie = (r.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!r.ok || !cookie) throw new Error(`Open Library login failed (${r.status})`);
  return cookie;
}

// Add one field to an edition. Read-modify-write against the live record, and
// refuse at the last moment if the blank has been filled since the proposal was
// queued — a queue can sit for days, and someone else may have got there first.
export async function sendField(olid, field, value, comment, cookie, doFetch = globalThis.fetch) {
  const spec = FIELDS.find((f) => f.name === field);
  if (!spec) throw new Error(`unknown field ${field}`);
  // The series tag is a subject on the work; everything else is on the edition.
  const path = spec.target === 'work' ? `/works/${olid}` : `/books/${olid}`;

  const r = await doFetch(`${OL}${path}.json`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`could not re-read ${olid} (${r.status})`);
  const record = await r.json();
  if (spec.has(record)) throw new Error(`${olid} already has ${field} — not overwriting`);

  const body = spec.apply
    ? { ...spec.apply(record, value), _comment: comment }
    : { ...record, [field]: field === 'number_of_pages' ? Number(value) : value, _comment: comment };
  const put = await doFetch(`${OL}${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  if (!put.ok) throw new Error(`Open Library rejected the edit (${put.status})`);
  return true;
}

// Covers go through a separate multipart endpoint, not the JSON record.
export async function sendCover(olid, imageBuffer, cookie, doFetch = globalThis.fetch) {
  const form = new FormData();
  form.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), `${olid}.jpg`);
  form.append('url', '');
  form.append('upload', 'Submit');
  const r = await doFetch(`${OL}/books/${olid}/add-cover`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
    redirect: 'manual',
  });
  // The endpoint redirects to the book page on success.
  if (!r.ok && r.status !== 302 && r.status !== 303) {
    throw new Error(`Open Library rejected the cover (${r.status})`);
  }
  return true;
}
