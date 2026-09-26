// deploy/failover.sh, run in a sandbox with every outside command stubbed.
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
const SCRIPT = join(ROOT, 'deploy/failover.sh');

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
  for (const name of ['tailscale', 'ip', 'systemctl', 'sqlite3', 'curl', 'docker']) stub(name);
  writeFileSync(join(dir, 'OWNER'), `${owner}\n`);
  writeFileSync(join(dir, 'library.db'), 'not really a database');
  return { dir, calls };
}

function run(box, mode) {
  const r = spawnSync('sh', [SCRIPT, mode], {
    env: {
      PATH: `${box.dir}:${process.env.PATH}`,
      ME: 'homelab',
      PEER: 'racknerd',
      KEY: join(box.dir, 'no-such-key'),
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
  const box = sandbox('racknerd 25');
  try {
    const r = run(box, 'to-remote');
    assert.doesNotMatch(r.stderr, /another failover is already running/);
    assert.match(r.stderr, /released the VIP on homelab/);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('a second, separate run is still refused while one holds the lock', () => {
  const box = sandbox('racknerd 25');
  try {
    // flock(1) holds the lock while the script tries to take it.
    const r = spawnSync('flock', [join(box.dir, 'lock'), 'sh', '-c',
      `ME=homelab PEER=racknerd KEY=x DATA_DIR='${box.dir}' OWNER_FILE='${box.dir}/OWNER' `
      + `ACTIVE_FLAG='${box.dir}/active' LOCK='${box.dir}/lock' PATH='${box.dir}':"$PATH" `
      + `sh '${SCRIPT}' status`], { encoding: 'utf8', timeout: 30000 });
    assert.match(r.stderr, /another failover is already running/);
    assert.notEqual(r.status, 0);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});
