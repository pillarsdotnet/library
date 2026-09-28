// Refuse a dependency tree with a known vulnerability or a deprecated package.
// Run by the pre-commit hook and by CI: `npm run check:deps`.
//
// Vulnerabilities come from `npm audit`, at every severity and in dev
// dependencies too. Deprecations need more than npm offers: `npm ci` only
// repeats the "deprecated" notes written into package-lock.json when a package
// was resolved, and re-resolving the lockfile does not refresh them, so a
// package deprecated after it was locked passes silently. Each locked version
// is therefore looked up in the registry itself.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.npmjs.org/';
const CONCURRENCY = 16; // ~310 packages at ~0.4 s each: 2 minutes in series, seconds in parallel

let failed = false;

try {
  execFileSync('npm', ['audit'], { stdio: 'inherit' });
} catch {
  failed = true;
  console.error('\n✖ npm audit reports vulnerabilities. Fix them (`npm audit fix`, an upgrade, or an override).');
}

// Every installed package and version, from the lockfile. Linked workspaces and
// the root have no version to look up.
const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url)));
const wanted = new Map(); // name -> Set of versions
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path || meta.link || !meta.version) continue;
  const name = meta.name || path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (!wanted.has(name)) wanted.set(name, new Set());
  wanted.get(name).add(meta.version);
}

// The abbreviated ("corgi") document is a fraction of the full one and still
// carries each version's deprecation.
async function deprecations(name) {
  const r = await fetch(REGISTRY + name.replace('/', '%2F'), {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!r.ok) throw new Error(`${name}: registry answered ${r.status}`);
  const { versions } = await r.json();
  return [...wanted.get(name)]
    .filter((v) => versions[v]?.deprecated)
    .map((v) => `${name}@${v}: ${versions[v].deprecated}`);
}

const names = [...wanted.keys()];
const found = [];
const errors = [];
const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (names.length) {
    const name = names.pop();
    try { found.push(...await deprecations(name)); } catch (err) { errors.push(err.message); }
  }
}));
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (errors.length) {
  failed = true;
  console.error(`\n✖ Could not check ${errors.length} package(s) for deprecation:`);
  for (const e of errors) console.error('    ' + e);
}
if (found.length) {
  failed = true;
  console.error('\n✖ Deprecated packages are installed:');
  for (const d of found.sort()) console.error('    ' + d);
  console.error('  Upgrade or replace whatever depends on them (`npm ls <package>` shows what does).');
} else if (!errors.length) {
  console.log(`no deprecated packages (${wanted.size} checked in ${seconds}s)`);
}

process.exit(failed ? 1 : 0);
