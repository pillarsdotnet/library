// SQLite's date('now','localtime') decides what is overdue, and it takes the
// timezone from the C library, which reads TZ against /usr/share/zoneinfo.
// Node's Intl carries its own timezone data and never looks there. So an image
// without the zoneinfo files (a base image that leaves out tzdata) logs the
// right timezone at startup while judging due dates in UTC. This compares the
// two in each zone and fails when they disagree. CI also runs it inside the
// Docker image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// A zone with daylight saving (the deployment's), both extremes of the date
// line (the ones due-dates.test.mjs relies on), and a half-hour offset.
const ZONES = ['America/New_York', 'Etc/GMT+12', 'Etc/GMT-14', 'Asia/Kolkata'];

// Both offsets in minutes east of UTC, measured in a child running under TZ at
// the same instant. It is a whole minute, because Intl's parts stop at minutes:
// with seconds left in, the two come out a minute apart.
const probe = `
  import Database from 'better-sqlite3';
  const now = new Date(Math.floor(Date.now() / 60000) * 60000);
  const sqlite = Math.round(new Database(':memory:').prepare(
    "SELECT (julianday(?, 'unixepoch', 'localtime') - julianday(?, 'unixepoch')) * 1440 AS m",
  ).get(now / 1000, now / 1000).m);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(now).map((p) => [p.type, Number(p.value)]));
  const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const intl = Math.round((local - now.getTime()) / 60000);
  console.log(JSON.stringify({ sqlite, intl }));
`;

for (const tz of ZONES) {
  test(`SQLite's localtime honours TZ=${tz}`, () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const { sqlite, intl } = JSON.parse(r.stdout);
    assert.notEqual(intl, 0, `Intl should not put ${tz} on UTC`);
    assert.equal(sqlite, intl, `SQLite is ${sqlite} min from UTC, Intl ${intl}: zoneinfo for ${tz} is missing`);
  });
}
