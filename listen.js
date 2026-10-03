// Where the server listens. Three ways, tried in this order:
//
//   1. A socket systemd opened and handed over (socket activation). systemd
//      passes it as file descriptor 3 and says so in LISTEN_FDS, with
//      LISTEN_PID naming the process it is meant for. The Debian package runs
//      the app this way, so the socket's owner, group and mode are set in
//      home-library.socket rather than here, and the web server talks to it
//      over a file in /run that only it may open.
//   2. A Unix socket at SOCKET_PATH, for running behind a web server without
//      systemd's help. A socket file left by a previous run would make the
//      listen fail with EADDRINUSE, so it is removed first. SOCKET_MODE, in
//      octal, sets who may connect: 660 for owner and group, say.
//   3. A TCP port, PORT, defaulting to 3000. This is what the Docker image does
//      and what it has always done.
import { chmodSync, rmSync } from 'node:fs';

// systemd's first passed descriptor is always 3: 0-2 are stdio.
const SD_LISTEN_FDS_START = 3;

/** Decide where to listen from the environment. Pure, so it can be tested. */
export function listenTarget(env = process.env, pid = process.pid) {
  const fds = Number.parseInt(env.LISTEN_FDS ?? '', 10);
  // A LISTEN_PID for some other process means the variables were inherited by
  // a child of the one systemd started, and the descriptor is not ours to take.
  const forUs = !env.LISTEN_PID || Number.parseInt(env.LISTEN_PID, 10) === pid;
  if (fds >= 1 && forUs) return { kind: 'fd', fd: SD_LISTEN_FDS_START };

  if (env.SOCKET_PATH) {
    const mode = env.SOCKET_MODE ? Number.parseInt(env.SOCKET_MODE, 8) : null;
    if (mode !== null && (Number.isNaN(mode) || mode < 0 || mode > 0o777)) {
      throw new Error(`SOCKET_MODE must be an octal mode such as 660, not "${env.SOCKET_MODE}"`);
    }
    return { kind: 'path', path: env.SOCKET_PATH, mode };
  }

  return { kind: 'port', port: Number(env.PORT || 3000) };
}

/** Where a visitor's browser would point, for the startup banner. */
export function describeTarget(target, base = '') {
  switch (target.kind) {
    case 'fd': return `the socket systemd passed in (fd ${target.fd}), under ${base || '/'}`;
    case 'path': return `unix:${target.path}, under ${base || '/'}`;
    default: return `http://localhost:${target.port}${base}/`;
  }
}

/** Start `app` listening on `target`; `onListening` runs once it is up. */
export function listen(app, target, onListening) {
  if (target.kind === 'fd') return app.listen({ fd: target.fd }, onListening);
  if (target.kind === 'path') {
    rmSync(target.path, { force: true });
    return app.listen(target.path, () => {
      if (target.mode !== null) chmodSync(target.path, target.mode);
      onListening();
    });
  }
  return app.listen(target.port, onListening);
}
