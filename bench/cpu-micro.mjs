// CPU micro-benchmarks, run INSIDE an app image by bench/cpu.sh, so that the
// image's own node_modules -- its compiled better-sqlite3 and sharp, and its
// libc -- are what is timed. README.md compares the variants, using its results.
//
// Each workload is a fixed amount of work; the best of REPS timings is reported,
// with the CPU time the process used for that repetition. BENCH_DB is a copy of
// a real library database, read-only here; ONLY=a,b limits the workloads.
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const require = createRequire('/app/package.json');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { zipSync, unzipSync } = require('fflate');
const { sortTitle } = await import('/app/sorttitle.js');

sharp.concurrency(1);   // per-core cost, not how many threads libvips can spread over
sharp.cache(false);     // or every resize after the first is a cache hit

const REPS = Number(process.env.REPS || 3);
const DB = process.env.BENCH_DB || '/data/library.db';

const real = new Database(DB, { readonly: true });
const rows = real.prepare('SELECT * FROM books').all();
const titles = rows.map((r) => r.title || '');
const booksJson = JSON.stringify(rows);
const cover = readFileSync('/app/test/fixtures/sample-cover.png');
const blob = Buffer.from(JSON.stringify(Array.from({ length: 40 }, () => rows)).slice(0, 1 << 20));
const key = randomBytes(32);

const workloads = {
  // Native, allocation-heavy: SQLite's own malloc traffic.
  sqlite_insert_100k() {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER, c REAL)');
    const ins = db.prepare('INSERT INTO t (a, b, c) VALUES (?, ?, ?)');
    db.transaction(() => { for (let i = 0; i < 100000; i++) ins.run(`row ${i} some text`, i, i / 3); })();
    db.prepare('CREATE INDEX t_a ON t(a)').run();
    db.close();
  },
  // What GET /api/books does, minus HTTP: the books view, all rows, 200 times.
  sqlite_books_view_x200() {
    const s = real.prepare('SELECT * FROM books ORDER BY title');
    for (let i = 0; i < 200; i++) s.all();
  },
  json_roundtrip_x200() {
    for (let i = 0; i < 200; i++) JSON.parse(JSON.stringify(rows));
  },
  // libvips through sharp: decode the PNG cover, resize, encode JPEG.
  sharp_resize_x100: async () => {
    for (let i = 0; i < 100; i++) await sharp(cover).resize(300).jpeg({ quality: 80 }).toBuffer();
  },
  // Session cookies and sealed Open Library keys.
  aes_gcm_seal_open_x100k() {
    for (let i = 0; i < 100000; i++) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update('an-open-library-access-key'), c.final()]);
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(c.getAuthTag());
      Buffer.concat([d.update(body), d.final()]);
    }
  },
  hmac_sha256_x200k() {
    for (let i = 0; i < 200000; i++) createHmac('sha256', key).update(booksJson.slice(0, 200)).digest('base64url');
  },
  zlib_1MB_x50() {
    for (let i = 0; i < 50; i++) inflateSync(deflateSync(blob));
  },
  // EPUB import unzips with fflate: pure JS.
  fflate_zip_1MB_x50() {
    for (let i = 0; i < 50; i++) unzipSync(zipSync({ 'a.json': blob }));
  },
  // App code: the sort key for every title, 500 times.
  sorttitle_x500() {
    for (let i = 0; i < 500; i++) for (const t of titles) sortTitle(t);
  },
  // Controls. V8's own heap, which libc never sees...
  // Kept in a ring of a million, so V8 cannot optimise the allocation away.
  js_objects_5M() {
    const ring = new Array(1e6);
    for (let i = 0; i < 5e6; i++) ring[i % 1e6] = { i, s: `k${i & 1023}`, a: [i, i + 1] };
    return ring.length;
  },
  // ...and libc's malloc directly: Buffers over the pool size are malloc'd.
  malloc_buffers_200k() {
    for (let i = 0; i < 200000; i++) Buffer.alloc(16384 + (i & 4095)).fill(i & 255);
  },
};

const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const out = {};
for (const [name, fn] of Object.entries(workloads)) {
  if (only && !only.has(name)) continue;
  await fn();   // warm-up: JIT, page cache, lazy init
  let best = null;
  for (let r = 0; r < REPS; r++) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    await fn();
    const ms = performance.now() - t0;
    const c = process.cpuUsage(c0);
    const cpuMs = (c.user + c.system) / 1000;
    if (!best || ms < best.ms) best = { ms: +ms.toFixed(2), cpu_ms: +cpuMs.toFixed(2) };
  }
  out[name] = best;
}
console.log(JSON.stringify({ node: process.version, rows: rows.length, results: out }));
