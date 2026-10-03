// The owner, user 1: a member of every library, and mailed about each new one.
//
// The mail goes to a stub SMTP server that speaks STARTTLS with a throwaway
// certificate, which the app is told to trust through NODE_EXTRA_CA_CERTS, the
// same verification path Gmail's real certificate goes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3234;
const GOOGLE_PORT = 3232;
const SMTP_PORT = 3233;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), 'home-library-owner-'));
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const SMTP_USER = 'sender@gmail.com';
const SMTP_PASSWORD = 'app password';

let server, google, smtp;
let nextEmail = null;
let offerStartTls = true;
const received = [];   // one entry per conversation: { tls, auth, from, to, data }

function idToken(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.x`;
}

// Just enough of RFC 5321 and 3207 to take one message.
function smtpServer(key, cert) {
  return net.createServer((plain) => {
    const conv = { tls: false, auth: null, from: null, to: [], data: '' };
    received.push(conv);
    let socket = plain;
    let buffer = '';
    let inData = false;
    const say = (line) => socket.write(`${line}\r\n`);
    const onData = (d) => {
      buffer += d;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          conv.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          say('250 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          if (offerStartTls && !conv.tls) say('250-stub');
          say(offerStartTls && !conv.tls ? '250 STARTTLS' : '250 AUTH PLAIN');
        } else if (verb === 'STARTTLS') {
          say('220 go ahead');
          plain.removeListener('data', onData);
          socket = new tls.TLSSocket(plain, { isServer: true, key, cert });
          socket.setEncoding('utf8');
          socket.on('data', onData);
          socket.on('error', () => {});
          conv.tls = true;
          return;
        } else if (verb === 'AUTH') {
          conv.auth = Buffer.from(line.split(' ')[2], 'base64').toString();
          say('235 ok');
        } else if (verb === 'MAIL') {
          conv.from = line.match(/<(.*)>/)[1];
          say('250 ok');
        } else if (verb === 'RCPT') {
          conv.to.push(line.match(/<(.*)>/)[1]);
          say('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 go');
        } else if (verb === 'QUIT') {
          say('221 bye');
          socket.end();
        } else {
          say('500 what');
        }
      }
    };
    plain.setEncoding('utf8');
    plain.on('data', onData);
    plain.on('error', () => {});
    plain.on('close', () => { conv.closed = true; });
    say('220 stub ESMTP');
  });
}

test.before(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(TMP, 'key.pem'), '-out', join(TMP, 'cert.pem'),
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const key = readFileSync(join(TMP, 'key.pem'));
  const cert = readFileSync(join(TMP, 'cert.pem'));
  smtp = smtpServer(key, cert);
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));

  google = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${GOOGLE_PORT}`);
    if (url.pathname === '/auth') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'c');
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id_token: idToken({
      aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 3600,
      email: nextEmail, email_verified: true,
    }) }));
  });
  await new Promise((r) => google.listen(GOOGLE_PORT, '127.0.0.1', r));

  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: join(TMP, 'library.db'),
      COVERS_DIR: join(TMP, 'covers'),
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_AUTH_URL: `http://127.0.0.1:${GOOGLE_PORT}/auth`,
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${GOOGLE_PORT}/token`,
      AUTH_ALLOWED_FILE: join(TMP, 'none.txt'),
      SESSION_SECRET: 'owner-secret',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(SMTP_PORT),
      SMTP_USER,
      SMTP_PASSWORD,
      NODE_EXTRA_CA_CERTS: join(TMP, 'cert.pem'),
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${BASE}/auth/me`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not become ready');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(async () => {
  if (server) server.kill('SIGKILL');
  await Promise.all([google, smtp].map((s) => s && new Promise((r) => s.close(r))));
  rmSync(TMP, { recursive: true, force: true });
});

// Returns the callback's status and the session cookie, if one was issued.
async function signIn(email, library) {
  nextEmail = email;
  const post = await fetch(`${BASE}/auth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ library }).toString(),
  });
  const flow = (post.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const atGoogle = await fetch(post.headers.get('location'), { redirect: 'manual' });
  const cb = await fetch(atGoogle.headers.get('location'), { redirect: 'manual', headers: { Cookie: flow } });
  const session = (cb.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('hl_session='));
  return { status: cb.status, session };
}

const members = async (session) => (await fetch(`${BASE}/api/library/members`, { headers: { Cookie: session } })).json();

// Mail goes after the response, so it is waited for rather than assumed.
async function nextConversation(count) {
  const deadline = Date.now() + 10000;
  while (received.length < count || (received[count - 1].data === '' && !received[count - 1].closed)) {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return received[count - 1];
}

// The decoded text of a base64 message body.
const bodyOf = (data) => Buffer.from(data.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString();

let ownerSession;

test('the first person to sign in is the owner, and hears of their own library too', async () => {
  const first = await signIn('owner@gmail.com', 'First');
  assert.equal(first.status, 302);
  ownerSession = first.session;
  const m = await members(ownerSession);
  assert.deepEqual(m.map((x) => [x.email, x.owner]), [['owner@gmail.com', true]]);
  const mail = await nextConversation(1);
  assert.deepEqual(mail.to, ['owner@gmail.com']);
});

test('a stranger\'s new library has the owner in it, and the owner is mailed', async () => {
  const made = await signIn('stranger@gmail.com', 'Café Shelf');
  assert.equal(made.status, 302, 'the founder is signed in');
  const m = await members(made.session);
  assert.deepEqual(m.map((x) => x.email), ['owner@gmail.com', 'stranger@gmail.com']);

  const mail = await nextConversation(2);
  assert.equal(mail.tls, true, 'the conversation went encrypted');
  assert.equal(mail.auth, `\0${SMTP_USER}\0${SMTP_PASSWORD}`, 'signed in with the app password');
  assert.equal(mail.from, SMTP_USER);
  assert.deepEqual(mail.to, ['owner@gmail.com']);
  const subject = mail.data.match(/^Subject: =\?UTF-8\?B\?(.*)\?=$/m)?.[1];
  assert.equal(Buffer.from(subject ?? '', 'base64').toString(), 'New library: Café Shelf Library', 'a non-ASCII name is encoded');
  const body = bodyOf(mail.data);
  assert.match(body, /stranger@gmail\.com created Café Shelf Library/);
  assert.match(body, new RegExp(`${BASE}/auth/login`));

  const again = await signIn('owner@gmail.com', 'café shelf');
  assert.equal(again.status, 302, 'the owner signs in to it without being added');
});

test('the owner cannot be removed from a library', async () => {
  const { session } = await signIn('stranger@gmail.com', 'Café Shelf');
  const ownerRow = (await members(session)).find((x) => x.owner);
  const r = await fetch(`${BASE}/api/library/members/${ownerRow.id}`, { method: 'DELETE', headers: { Cookie: session } });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /owner/);
});

test('without STARTTLS the password is never sent, and sign-in still works', async () => {
  offerStartTls = false;
  try {
    const made = await signIn('another@gmail.com', 'Plaintext Hall');
    assert.equal(made.status, 302, 'a mail failure does not break creating a library');
    const mail = await nextConversation(3);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mail.auth, null, 'no AUTH in clear');
    assert.deepEqual(mail.to, [], 'and nothing sent');
  } finally {
    offerStartTls = true;
  }
});

// The database's part, on a database of its own: loading db.js is what
// creates the schema, the triggers and the backfill.
test('the owner joins libraries made before them, and any they were left out of', async () => {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = join(TMP, 'fresh.db');
  const load = () => execFileSync('node', ['-e', "import('./db.js')"], {
    cwd: ROOT, env: { ...process.env, DB_PATH: dbPath, AUTH_ALLOWED_FILE: join(TMP, 'none.txt') }, stdio: 'ignore',
  });
  load();   // the first library, and nobody yet

  const db = new Database(dbPath);
  const inOwner = () => db.prepare('SELECT library_id FROM library_users WHERE user_id = 1 ORDER BY 1').all().map((r) => r.library_id);
  db.prepare("INSERT INTO libraries (name) VALUES ('Before The Owner')").run();
  assert.deepEqual(inOwner(), [], 'no owner, no membership');
  db.prepare("INSERT INTO users (email) VALUES ('first@gmail.com')").run();
  assert.deepEqual(inOwner(), [1, 2], 'the owner, on appearing, joins every library');
  db.prepare("INSERT INTO libraries (name) VALUES ('After')").run();
  assert.deepEqual(inOwner(), [1, 2, 3], 'and every library made after');

  // A membership lost by some other route comes back at the next start.
  db.prepare('DELETE FROM library_users WHERE user_id = 1 AND library_id = 2').run();
  db.close();
  load();
  const again = new Database(dbPath);
  assert.deepEqual(again.prepare('SELECT library_id FROM library_users WHERE user_id = 1 ORDER BY 1').all().map((r) => r.library_id), [1, 2, 3]);
  again.close();
});
