// Compare runtime memory of Docker images under the same workload -- in
// practice the slim and alpine variants, and slim with its allocator tuned.
// README.md compares the variants, using its results.
//
// Usage: node bench/memory.mjs <config> [<config> ...]
//   where a config is an image, optionally with container environment:
//   ghcr.io/pillarsdotnet/library:latest,MALLOC_ARENA_MAX=2
//   RUNS=3 (per config, interleaved), CPUS=2, MEMORY=1g, BOOKS=2000,
//   READS=3000, IMPORTS=300
//
// Each run: fresh container and volume, same limits. Phases: idle after start,
// seed books, mixed reads, EPUB imports (sharp/libvips), idle again. Sampled
// every 500 ms from the host, without touching the container:
//   rss / hwm  - node's VmRSS and VmHWM from /proc/<pid>/status
//   anon       - the container cgroup's anonymous memory (memory.stat)
//
// Linux only: it reads /proc and the cgroup v2 tree of Docker's systemd driver.
// Run it on the architecture being measured; under an emulator, the emulator's
// own memory is counted too.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import sharp from 'sharp';

const configs = process.argv.slice(2);
if (!configs.length) throw new Error('usage: node bench/memory.mjs <image[,KEY=VALUE...]>...');

const env = (k, d) => Number(process.env[k] ?? d);
const RUNS = env('RUNS', 3), BOOKS = env('BOOKS', 2000), READS = env('READS', 3000);
const IMPORTS = env('IMPORTS', 300), CONC = 8;
const CPUS = process.env.CPUS ?? '2', MEMORY = process.env.MEMORY ?? '1g';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const log = (...a) => console.error(...a);

// ---- workload inputs, built once so every run gets identical bytes ----------
const WORDS = ['river', 'glass', 'winter', 'garden', 'shadow', 'iron', 'harbor', 'ember',
  'orchard', 'lantern', 'meadow', 'silver', 'thorn', 'compass', 'tide', 'quarry'];
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = (a) => a[Math.floor(rand() * a.length)];
const title = () => Array.from({ length: 2 + Math.floor(rand() * 4) }, () => pick(WORDS)).join(' ');
const day = (off) => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);

const books = Array.from({ length: BOOKS }, (_, i) => ({
  title: `${title()} ${i}`,
  authors: `${pick(WORDS)} ${pick(WORDS)}`,
  publisher: `${pick(WORDS)} press`,
  published_date: String(1900 + Math.floor(rand() * 125)),
  format: pick(['hardcover', 'paperback', 'ebook']),
  status: pick(['tbr', 'reading', 'read']),
  notes: pick(WORDS).repeat(1 + Math.floor(rand() * 40)),
  ...(rand() < 0.1 ? { is_library_book: 1, due_date: day(Math.floor(rand() * 40) - 20) } : {}),
}));

const READ_PATHS = ['/api/books?limit=0', '/api/books?limit=50&offset=500', '/api/books?q=river',
  '/api/books?q=silver%20tide', '/api/books?status=read', '/api/books?format=ebook',
  '/api/books?library=1', '/api/books?library=overdue', '/api/meta', '/api/shelves'];

log('building covers…');
// 2400x3600 noisy JPEGs: large and incompressible enough to make libvips work.
const covers = await Promise.all(Array.from({ length: 12 }, (_, i) => sharp({
  create: { width: 2400, height: 3600, channels: 3,
    background: { r: 20 * i, g: 128, b: 255 - 20 * i },
    noise: { type: 'gaussian', mean: 128, sigma: 40 } },
}).jpeg({ quality: 90 }).toBuffer()));
const epub = (i) => {
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Imported ${i}</dc:title>
<dc:creator>Author ${i}</dc:creator><dc:identifier id="id">urn:bench:${i}</dc:identifier>
<meta name="cover" content="c"/></metadata>
<manifest><item id="c" href="cover.jpg" media-type="image/jpeg"/></manifest></package>`;
  return Buffer.from(zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'content.opf': strToU8(opf),
    'cover.jpg': covers[i % covers.length],
  }, { level: 0 }));
};
log(`covers: ${covers.length} x ~${(covers[0].length / 1e6).toFixed(1)} MB`);

// ---- measurement -------------------------------------------------------------
const kb = (text, key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? NaN);
function sample(pid, cg) {
  const st = readFileSync(`/proc/${pid}/status`, 'utf8');
  const ms = readFileSync(`${cg}/memory.stat`, 'utf8');
  return {
    rss: kb(st, 'VmRSS') / 1024,
    hwm: kb(st, 'VmHWM') / 1024,
    anon: Number(/^anon (\d+)/m.exec(ms)[1]) / 2 ** 20,
  };
}

async function pool(n, jobs) {
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < n) {
      const i = next++;
      try { const r = await jobs(i); if (!r.ok) failed++; await r.arrayBuffer(); } catch { failed++; }
    }
  }));
  if (failed) throw new Error(`${failed}/${n} requests failed`);
}

async function run(config) {
  const [image, ...vars] = config.split(',');
  const vol = `membench-${process.pid}-${Date.now()}`;
  let id;
  try {
    id = sh('docker', ['run', '-d', '--rm', '--cpus', CPUS, '--memory', MEMORY,
      '-e', 'TZ=America/New_York', ...vars.flatMap((v) => ['-e', v]), '-v', `${vol}:/data`, '-p', '127.0.0.1::3000', image]);
  } catch (err) {
    // docker run can create the volume and still fail to start the container.
    execFileSync('docker', ['volume', 'rm', '-f', vol], { stdio: 'ignore' });
    throw err;
  }
  // Docker picks a free port, so two runs of this script cannot collide.
  const BASE = `http://${sh('docker', ['port', id, '3000/tcp']).split('\n')[0]}`;
  const pid = sh('docker', ['inspect', '-f', '{{.State.Pid}}', id]);
  const cg = `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
  const phases = [];
  let cur = null;
  const timer = setInterval(() => {
    if (!cur) return;
    try { const s = sample(pid, cg); cur.max = Math.max(cur.max, s.rss); cur.maxAnon = Math.max(cur.maxAnon, s.anon); } catch { /* exiting */ }
  }, 500);
  const phase = async (name, fn) => {
    const start = sample(pid, cg);
    cur = { name, max: start.rss, maxAnon: start.anon, t0: Date.now() };
    await fn();
    const end = sample(pid, cg);
    cur.max = Math.max(cur.max, end.rss); cur.maxAnon = Math.max(cur.maxAnon, end.anon);
    phases.push({ ...cur, secs: (Date.now() - cur.t0) / 1000, end });
    cur = null;
  };
  try {
    for (let t = Date.now(); ;) {
      try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
      if (Date.now() - t > 30000) throw new Error(`${image} did not start`);
      await sleep(200);
    }
    await phase('idle', () => sleep(10000));
    await phase('seed', () => pool(BOOKS, (i) => fetch(`${BASE}/api/books`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(books[i]) })));
    await phase('reads', () => pool(READS, (i) => fetch(BASE + (i % 7 === 6
      ? `/api/books/${1 + (i * 37) % BOOKS}` : READ_PATHS[i % READ_PATHS.length]))));
    await phase('imports', () => pool(IMPORTS, (i) => fetch(`${BASE}/api/import/epub`, {
      method: 'POST', headers: { 'Content-Type': 'application/epub+zip' }, body: epub(i) })));
    // The route imports without a cover if sharp fails, so prove it resized one.
    const imported = (await (await fetch(`${BASE}/api/books?q=Imported&limit=1`)).json())[0];
    const cover = await fetch(`${BASE}/api/books/${imported.id}/cover`);
    const jpeg = await sharp(Buffer.from(await cover.arrayBuffer())).metadata();
    if (!cover.ok || jpeg.width !== 500) throw new Error(`${image}: cover not resized (${cover.status}, ${jpeg.width}px)`);
    await phase('settle', () => sleep(30000));
    return { phases, hwm: sample(pid, cg).hwm,
      peak: Number(readFileSync(`${cg}/memory.peak`, 'utf8')) / 2 ** 20 };
  } finally {
    clearInterval(timer);
    execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
    execFileSync('docker', ['volume', 'rm', vol], { stdio: 'ignore' });
  }
}

// ---- runs, interleaved so drift on the host hits every config alike ---------
const results = Object.fromEntries(configs.map((i) => [i, []]));
for (let r = 1; r <= RUNS; r++) {
  for (const config of configs) {
    log(`run ${r}/${RUNS} ${config}…`);
    results[config].push(await run(config));
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const f = (x) => x.toFixed(0).padStart(6);
console.log(`\nMedians of ${RUNS} runs, MB (cpus=${CPUS}, memory=${MEMORY}, ${BOOKS} books, ${READS} reads, ${IMPORTS} imports)`);
for (const config of configs) {
  const rs = results[config];
  console.log(`\n${config}   peak RSS ${f(median(rs.map((r) => r.hwm)))}   cgroup peak ${f(median(rs.map((r) => r.peak)))}`);
  console.log('  phase      max RSS   end RSS  end anon    secs');
  for (const name of rs[0].phases.map((p) => p.name)) {
    const ps = rs.map((r) => r.phases.find((p) => p.name === name));
    console.log(`  ${name.padEnd(8)} ${f(median(ps.map((p) => p.max)))}    ${f(median(ps.map((p) => p.end.rss)))}    ${f(median(ps.map((p) => p.end.anon)))}  ${median(ps.map((p) => p.secs)).toFixed(1).padStart(6)}`);
  }
}
console.log('\nRaw:', JSON.stringify(results));
