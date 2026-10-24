// Measure the ISBN lookup fallbacks, one source at a time, to settle the order
// lookupIsbn consults them in: fastest first (Open Library is not measured —
// it is always first, being the source this app gives back to). Run it with a
// sample of this library's own ISBNs:
//
//   GOOGLE_BOOKS_API_KEY=… ISBNDB_API_KEY=… \
//     node bench/lookup-sources.mjs 9780316769174 9780765326355 …
//
// Keys come from the environment and are never printed. Each source is timed
// serially with a polite gap (ISBNdb's basic plan allows one request a second,
// and a scrape should never look like a flood); the sources themselves run
// concurrently, so the wall time is the slowest source's, not the sum.
import { fetchGoogleBooks, fetchIsbndb, fetchLoc, fetchBarnesNoble } from '../lookup.js';

const isbns = process.argv.slice(2);
if (!isbns.length) {
  console.error('usage: node bench/lookup-sources.mjs <isbn13>…');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const SOURCES = [
  ['googlebooks', (isbn) => fetchGoogleBooks(isbn, fetch, process.env.GOOGLE_BOOKS_API_KEY), 250],
  ...(process.env.ISBNDB_API_KEY
    ? [['isbndb', (isbn) => fetchIsbndb(isbn, fetch, process.env.ISBNDB_API_KEY), 1100]]
    : []),
  ['loc', (isbn) => fetchLoc(isbn, fetch), 250],
  ['barnesnoble', (isbn) => fetchBarnesNoble(isbn, fetch), 1100],
];

async function measure([name, fn, gapMs]) {
  const times = [];
  let hits = 0;
  for (const isbn of isbns) {
    const t0 = performance.now();
    let data = null;
    try { data = await fn(isbn); } catch { /* a throttle or outage counts as a miss */ }
    times.push(performance.now() - t0);
    if (data?.title) hits += 1;
    await sleep(gapMs);
  }
  return { name, medianMs: Math.round(median(times)), hits, asked: isbns.length };
}

const results = await Promise.all(SOURCES.map(measure));
results.sort((a, b) => a.medianMs - b.medianMs);
console.log(`\n${isbns.length} ISBNs per source\n`);
for (const r of results) {
  console.log(`${r.name.padEnd(12)} median ${String(r.medianMs).padStart(5)} ms   found ${r.hits}/${r.asked}`);
}
