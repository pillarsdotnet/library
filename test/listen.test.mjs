// The Docker image listens on PORT and the Debian package on a socket systemd
// hands over; the same server.js has to pick the right one from its
// environment alone, and a wrong pick is a server nobody can reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';
import { listenTarget, listen } from '../listen.js';

test('PORT, defaulting to 3000, when nothing else is set', () => {
  assert.deepEqual(listenTarget({}, 1), { kind: 'port', port: 3000 });
  assert.deepEqual(listenTarget({ PORT: '30800' }, 1), { kind: 'port', port: 30800 });
});

test('a systemd-passed socket wins over SOCKET_PATH and PORT', () => {
  const env = { LISTEN_FDS: '1', LISTEN_PID: '42', SOCKET_PATH: '/x', PORT: '1' };
  assert.deepEqual(listenTarget(env, 42), { kind: 'fd', fd: 3 });
});

test('a passed socket meant for another process is left alone', () => {
  const env = { LISTEN_FDS: '1', LISTEN_PID: '42', PORT: '8080' };
  assert.deepEqual(listenTarget(env, 43), { kind: 'port', port: 8080 });
});

test('SOCKET_PATH, with SOCKET_MODE read as octal', () => {
  assert.deepEqual(listenTarget({ SOCKET_PATH: '/run/x.sock', SOCKET_MODE: '660' }, 1),
    { kind: 'path', path: '/run/x.sock', mode: 0o660 });
  assert.deepEqual(listenTarget({ SOCKET_PATH: '/run/x.sock' }, 1),
    { kind: 'path', path: '/run/x.sock', mode: null });
  assert.throws(() => listenTarget({ SOCKET_PATH: '/x', SOCKET_MODE: 'rw' }, 1), /SOCKET_MODE/);
});

test('serves over a Unix socket, replacing a stale socket file, with the mode asked for', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'listen-')), 'app.sock');
  writeFileSync(path, ''); // what a crashed previous run leaves behind
  const app = express();
  app.get('/ping', (_req, res) => res.send('pong'));
  const server = await new Promise((resolve) => {
    const s = listen(app, { kind: 'path', path, mode: 0o660 }, () => resolve(s));
  });
  try {
    assert.equal(statSync(path).mode & 0o777, 0o660);
    const body = await new Promise((resolve, reject) => {
      http.get({ socketPath: path, path: '/ping' }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; }).on('end', () => resolve(b));
      }).on('error', reject);
    });
    assert.equal(body, 'pong');
  } finally {
    server.close();
  }
});
