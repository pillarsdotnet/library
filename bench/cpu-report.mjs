// Summarise bench/cpu.sh's output: for each metric, the median over rounds for
// each config, its ratio to the first config, and the spread (max/min over
// rounds) that says how far to trust it.
//
// Usage: node bench/cpu-report.mjs bench-cpu.jsonl
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: node bench/cpu-report.mjs <results.jsonl>');
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const configs = rows.filter((r) => r.kind === 'image').map((r) => r.config);
const series = new Map();   // metric -> config -> values
const add = (metric, config, value) => {
  if (!series.has(metric)) series.set(metric, new Map());
  const m = series.get(metric);
  if (!m.has(config)) m.set(config, []);
  m.get(config).push(value);
};

for (const r of rows) {
  if (r.kind === 'micro') {
    for (const [name, res] of Object.entries(r.data.results)) add(`micro ${name} ms`, r.config, res.ms);
  } else if (r.kind === 'startup') {
    add('startup to healthz ms', r.config, r.ms);
    add('startup CPU ms', r.config, r.cpu_us / 1000);
  } else if (r.kind === 'http') {
    const d = r.data;
    if (d.errors) console.error(`!! ${r.config} round ${r.round} ${d.path}: ${d.errors} errors`);
    add(`http ${d.path} req/s`, r.config, d.rps);
    add(`http ${d.path} server CPU µs/req`, r.config, r.server_cpu_us / d.requests);
    add(`http ${d.path} p99 ms`, r.config, d.p99_ms);
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

configs.forEach((c, i) => console.log(`[${i}] ${c}`));
console.log(['metric'.padEnd(40), ...configs.map((_, i) => `[${i}]`.padStart(10)),
  ...configs.slice(1).map((_, i) => `[${i + 1}]/[0]`.padStart(9)), '  spread (max/min)'].join(''));
for (const [metric, byConfig] of series) {
  if (!configs.every((c) => byConfig.has(c))) continue;
  const med = configs.map((c) => median(byConfig.get(c)));
  const spread = configs.map((c) => {
    const xs = byConfig.get(c);
    return (Math.max(...xs) / Math.min(...xs)).toFixed(2);
  });
  console.log([metric.padEnd(40), ...med.map((m) => m.toFixed(2).padStart(10)),
    ...med.slice(1).map((m) => (m / med[0]).toFixed(2).padStart(9)), `  ${spread.join(' | ')}`].join(''));
}
