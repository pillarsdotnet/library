// Fast unit tests for the pure helpers in public/app.js. app.js is a classic
// browser script (no exports), so we extract the individual functions by name
// and evaluate them in isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appJs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/app.js'), 'utf8');

function loadFunction(name) {
  const m = appJs.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`));
  assert.ok(m, `could not find function ${name} in public/app.js`);
  return eval(`(${m[0].trim().replace(new RegExp(`^function ${name}`), 'function')})`);
}

test('isValidEan accepts valid EAN-13/EAN-8/UPC-A and rejects bad input', () => {
  const isValidEan = loadFunction('isValidEan');
  assert.equal(isValidEan('9780134685991'), true, 'Effective Java ISBN-13');
  assert.equal(isValidEan('9780747532699'), true, "Harry Potter ISBN-13");
  assert.equal(isValidEan('9780425179673'), true, 'The River King ISBN-13');
  assert.equal(isValidEan('036000291452'), true, 'UPC-A');
  assert.equal(isValidEan('96385074'), true, 'EAN-8');
  assert.equal(isValidEan('9780134685990'), false, 'wrong check digit');
  assert.equal(isValidEan('12345'), false, 'wrong length');
  assert.equal(isValidEan('97801346859ab'), false, 'non-numeric');
});

test('scannerErrorHelp tailors camera guidance to the platform', () => {
  const scannerErrorHelp = loadFunction('scannerErrorHelp');
  const wrapped = { name: 'Error', message: 'Error getting userMedia, error = NotAllowedError: denied' };
  Object.defineProperty(globalThis, 'window', { value: { isSecureContext: true }, configurable: true });
  const setUA = (ua, mtp = 0) =>
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua, maxTouchPoints: mtp }, configurable: true });

  setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) CriOS/126 Mobile Safari/604.1', 5);
  assert.match(scannerErrorHelp(wrapped), /Safari/, 'iOS Chrome should be told to use Safari');

  setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile Safari/604.1', 5);
  assert.match(scannerErrorHelp(wrapped), /Website Settings|Lockdown/, 'iOS Safari gets the permission path');

  setUA('Mozilla/5.0 (X11; Linux x86_64) Chrome/126 Safari/537.36', 0);
  assert.match(scannerErrorHelp(wrapped), /Allow camera permission/);
  assert.doesNotMatch(scannerErrorHelp(wrapped), /Safari/, 'desktop should not mention Safari');

  const notFound = { name: 'Error', message: 'Error getting userMedia, error = NotFoundError: none' };
  assert.match(scannerErrorHelp(notFound), /No usable camera/);
});
