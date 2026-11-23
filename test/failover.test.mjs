// debian/failover/home-library-failover, run in a sandbox with every outside
// command stubbed.
//
// Each stub records its arguments and succeeds, so a test can ask what the
// script tried to do to the other node without there being one. These guard
// two bugs found during the 2026-09-26 handoff to racknerd, neither of which
// had ever been exercised:
//
//   * a standby's shutdown ran db-release, which pushed its stale copy over the
//     live database -- the generation guard passes equal generations, and every
//     handoff writes the same one to both nodes;
//   * to-local and to-remote re-ran the script for each step, and every step
//     found its own parent holding the lock and refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'debian/failover/home-library-failover');

function sandbox(owner) {
  const dir = mkdtempSync(join(tmpdir(), 'home-library-failover-'));
  const calls = join(dir, 'calls.log');
  // ssh answers what is asked before any decision -- the peer's name and its
  // owner marker -- and says the peer is healthy, so a handoff does not sit out
  // its full wait. Everything else only records that it was attempted.
  const stub = (name, body = '') => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}exit 0\n`);
    chmodSync(path, 0o755);
  };
  stub('ssh', `for a; do last="$a"; done
case "$last" in
  hostname) echo racknerd ;;
  owner-get) echo "${owner}" ;;
  health) echo 200 ;;
esac
`);
  // runuser: the packaged script drops to the app user to touch the database.
  for (const name of ['tailscale', 'ip', 'systemctl', 'curl', 'docker']) stub(name);
  // runuser must be transparent, not inert. The script runs every database
  // command through `runuser -u "$APP_USER" -- ...`, so a stub that only
  // records and exits 0 swallows the command it was asked to run -- and an
  // integrity_check that prints nothing reads as a corrupt database.
  stub('runuser', 'while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\n'
                + '[ "$1" = "--" ] && shift\n'
                + '[ $# -gt 0 ] && exec "$@"\n');
  // sqlite3 has to answer, not just record: the packaged script refuses to
  // hand over a database whose integrity_check does not say "ok", so a stub
  // that prints nothing reads as a corrupt database.
  stub('sqlite3', 'echo ok\n');
  writeFileSync(join(dir, 'OWNER'), `${owner}\n`);
  writeFileSync(join(dir, 'library.db'), 'not really a database');
  // The packaged script checks the failover key exists before it will do
  // anything, which the copy under deploy/ did not. Nothing reads it here:
  // ssh is stubbed.
  writeFileSync(join(dir, 'key'), 'not really a key');
  chmodSync(join(dir, 'key'), 0o600);
  return { dir, calls };
}

function run(box, mode) {
  const r = spawnSync('sh', [SCRIPT, mode], {
    env: {
      PATH: `${box.dir}:${process.env.PATH}`,
      ME: 'homelab',
      PEER: 'racknerd',
      // Both nodes run identical units, so the packaged script refuses to
      // act until something breaks the tie.
      PREFERRED: 'homelab',
      KEY: join(box.dir, 'key'),
      DATA_DIR: box.dir,
      OWNER_FILE: join(box.dir, 'OWNER'),
      ACTIVE_FLAG: join(box.dir, 'active'),
      LOCK: join(box.dir, 'lock'),
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  const log = existsSync(box.calls) ? readFileSync(box.calls, 'utf8') : '';
  // Asking the peer its name is harmless; anything else touched the other node.
  const acted = log.split('\n').filter((l) => l && !/ hostname$/.test(l));
  return { ...r, acted };
}

test('a standby shutting down hands nothing over', () => {
  const box = sandbox('racknerd 25');
  try {
    const r = run(box, 'db-release');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /racknerd owns the database; nothing to hand over/);
    assert.deepEqual(r.acted, [], 'a standby must not push, withdraw an address or start anything');
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// The other half, so the test above cannot pass by the script doing nothing at
// all: the owner does go on to act on the peer.
test('the owner shutting down does hand over', () => {
  const box = sandbox('homelab 25');
  try {
    const r = run(box, 'db-release');
    assert.doesNotMatch(r.stderr, /nothing to hand over/);
    assert.ok(r.acted.some((l) => l.startsWith('ssh ')), `expected calls to the peer, got:\n${r.acted.join('\n')}`);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('to-remote gets past its first step instead of tripping its own lock', () => {
  // homelab owns, so to-remote has real work to do. With racknerd owning, the
  // packaged script short-circuits with "nothing to hand over" and the test
  // would pass without ever reaching the step it exists to check.
  const box = sandbox('homelab 25');
  try {
    const r = run(box, 'to-remote');
    // The point of the test: every step of a handoff used to find its own
    // parent holding the lock and refuse.
    assert.doesNotMatch(r.stderr, /another failover is already running/);
    assert.ok(r.acted.some((l) => l.startsWith('ssh ')), `expected calls to the peer, got:\n${r.acted.join('\n')}`);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('a run that moves the database is refused while one holds the lock', () => {
  const box = sandbox('racknerd 25');
  const env = (extra) =>
    `ME=homelab PEER=racknerd PREFERRED=homelab KEY='${box.dir}/key' `
    + `DATA_DIR='${box.dir}' OWNER_FILE='${box.dir}/OWNER' `
    + `ACTIVE_FLAG='${box.dir}/active' LOCK='${box.dir}/lock' PATH='${box.dir}':"$PATH" `
    + `sh '${SCRIPT}' ${extra}`;
  try {
    // flock(1) holds the lock while the script tries to take it. Only the two
    // steps that actually move the database take it.
    const claim = spawnSync('flock', [join(box.dir, 'lock'), 'sh', '-c', env('db-claim')],
      { encoding: 'utf8', timeout: 30000 });
    assert.match(claim.stderr, /another failover is already running/);
    assert.notEqual(claim.status, 0);

    // ...and the ones that do not must NOT take it. This is the second bug
    // the suite exists for: when every step locked, to-local and to-remote
    // re-ran the script per step and each step found its own parent holding
    // the lock and refused. A status that blocks here is that bug returning.
    const status = spawnSync('flock', [join(box.dir, 'lock'), 'sh', '-c', env('status')],
      { encoding: 'utf8', timeout: 30000 });
    assert.doesNotMatch(status.stderr, /another failover is already running/);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});
