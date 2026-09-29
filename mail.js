// Mail to the server's owner, sent through Gmail's submission port.
//
// There is no MTA to hand mail to: the hosts run dma, which sends but never
// listens, so a container cannot reach it. The app therefore submits to
// smtp.gmail.com:587 itself, under an app password, the way the hosts' own dma
// does. Written out rather than pulled from a library for the same reason as
// the OAuth exchange in auth.js: it is a handful of documented commands.
//
// Two rules:
//
//   1. Off unless configured. With no SMTP_USER / SMTP_PASSWORD nothing is
//      sent, and the startup log says so.
//   2. The password never crosses the wire in clear. STARTTLS is required, with
//      the server's certificate verified; a server that does not offer it is
//      refused before AUTH is ever sent.
import net from 'node:net';
import tls from 'node:tls';
import { hostname } from 'node:os';

const TIMEOUT_MS = 30000;

export function mailConfig() {
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!user || !password) return null;
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    user,
    password,
  };
}

// RFC 2047, so a library named in any script survives a Subject header.
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

// Base64 lines of 76, which also spares the body any need for dot-stuffing.
const encodeBody = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');

export function composeMessage({ from, to, subject, text, date = new Date() }) {
  return [
    `From: Home Library <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(text),
  ].join('\r\n');
}

// One SMTP conversation. Replies are read whole (a multi-line reply ends at
// the line whose code is followed by a space), and each must carry the code
// expected, or the conversation ends with the server's own words as the error.
function conversation(socket) {
  let buffer = '';
  let waiting = null;
  let failed = null;
  const tryResolve = () => {
    const m = buffer.match(/^(?:\d{3}-.*\r?\n)*(\d{3})(?: .*)?\r?\n/);
    if (!m || !waiting) return;
    buffer = buffer.slice(m[0].length);
    const w = waiting;
    waiting = null;
    w.resolve({ code: Number(m[1]), text: m[0].trim() });
  };
  const fail = (e) => {
    failed = e;
    if (waiting) { const w = waiting; waiting = null; w.reject(e); }
  };
  const attach = (s) => {
    s.setEncoding('utf8');
    s.on('data', (d) => { buffer += d; tryResolve(); });
    s.on('error', fail);
    s.on('close', () => fail(new Error('SMTP connection closed')));
  };
  attach(socket);

  const reply = () => new Promise((resolve, reject) => {
    if (failed) return reject(failed);
    waiting = { resolve, reject };
    tryResolve();
  });
  const expect = async (codes, command) => {
    const r = await reply();
    if (!codes.includes(r.code)) {
      // Never echo AUTH: its argument is the password.
      throw new Error(`SMTP ${command?.startsWith('AUTH') ? 'AUTH' : command ?? 'greeting'} refused: ${r.text}`);
    }
    return r;
  };
  return {
    expect,
    async send(command, codes) {
      socket.write(`${command}\r\n`);
      return expect(codes, command);
    },
    // After STARTTLS the conversation continues over the encrypted socket.
    upgrade(secure) {
      socket.removeAllListeners('data').removeAllListeners('error').removeAllListeners('close');
      socket = secure;
      attach(secure);
    },
    get socket() { return socket; },
  };
}

export async function sendMail({ to, subject, text }, config = mailConfig()) {
  if (!config) return false;
  const { host, port, user, password } = config;
  const plain = net.connect({ host, port });
  const timer = setTimeout(() => plain.destroy(new Error(`SMTP timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  const smtp = conversation(plain);
  const helo = `EHLO ${hostname() || 'home-library'}`;
  try {
    await smtp.expect([220]);
    const caps = await smtp.send(helo, [250]);
    if (!/^250[- ]STARTTLS\b/im.test(caps.text)) throw new Error(`${host} does not offer STARTTLS; refusing to send the password in clear`);
    await smtp.send('STARTTLS', [220]);
    const secure = tls.connect({ socket: plain, host, ...(net.isIP(host) ? {} : { servername: host }) });
    await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    smtp.upgrade(secure);
    await smtp.send(helo, [250]);
    await smtp.send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`, [235]);
    await smtp.send(`MAIL FROM:<${user}>`, [250]);
    await smtp.send(`RCPT TO:<${to}>`, [250, 251]);
    await smtp.send('DATA', [354]);
    await smtp.send(`${composeMessage({ from: user, to, subject, text })}\r\n.`, [250]);
    await smtp.send('QUIT', [221]).catch(() => {});   // delivered already; a rude goodbye changes nothing
    return true;
  } finally {
    clearTimeout(timer);
    smtp.socket.destroy();
  }
}
