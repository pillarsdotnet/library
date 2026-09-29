// Closed-loop HTTP load for bench/cpu.sh: CONC workers, each sending its next
// request as soon as the last one answers, for SECONDS. cpu.sh always runs it
// from the first config's image, on cores apart from the server's, so the
// client is the same whichever image is being measured.
//
// Usage: node cpu-http.mjs <base-url> <path>
const [base, path] = process.argv.slice(2);
const CONC = Number(process.env.CONC || 8);
const SECONDS = Number(process.env.SECONDS || 10);
const lat = [];
let bytes = 0, errors = 0;
const end = performance.now() + SECONDS * 1000;
async function worker() {
  while (performance.now() < end) {
    const t0 = performance.now();
    try {
      const r = await fetch(base + path);
      bytes += (await r.arrayBuffer()).byteLength;
      if (!r.ok) errors++;
    } catch { errors++; }
    lat.push(performance.now() - t0);
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
const secs = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const q = (p) => +lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(2);
console.log(JSON.stringify({ path, requests: lat.length, errors, rps: +(lat.length / secs).toFixed(1),
  p50_ms: q(0.5), p99_ms: q(0.99), kb_per_req: +(bytes / lat.length / 1024).toFixed(1) }));
