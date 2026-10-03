// Regression test for nodejs/node#65446. From 24.19.0 on, Node aborts an addon
// built on node::ObjectWrap when garbage collection frees one of its objects.
// better-sqlite3 11 was such an addon and crashed CI; 12 onwards uses
// Napi::ObjectWrap and survives, which is what let the Node pin go. This fails
// if a dependency change brings the crash back.
//
// Proven to fail: better-sqlite3 11.10.0 on Node 24.21.0 aborts here, in both
// the Debian image and the since-dropped Alpine one, while 13 passes. CI also
// runs this inside the Docker image, since what matters is the module as
// compiled there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('freeing statements during garbage collection does not abort Node', () => {
  const fixture = new URL('./fixtures/gc-stress.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [fixture], { encoding: 'utf8' });
  assert.equal(
    r.status, 0,
    `exit ${r.status}, signal ${r.signal}\n${r.stderr.split('\n').slice(0, 12).join('\n')}`,
  );
  assert.equal(r.stdout.trim(), 'survived');
});
