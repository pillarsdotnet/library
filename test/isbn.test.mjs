// The ISBN canonicaliser is what stops one edition becoming two rows, so the
// property that matters most is the last test: both spellings of a book must
// reduce to the same string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIsbn } from '../isbn.js';

test('a valid ISBN-13 passes through unchanged', () => {
  assert.equal(canonicalIsbn('9780441013593'), '9780441013593');
});

test('an ISBN-10 is converted to its ISBN-13 form', () => {
  assert.equal(canonicalIsbn('0441013597'), '9780441013593');
});

test('the ISBN-10 check digit X is understood', () => {
  // 'X' means 10 in the final position; a naive digit parse would reject it.
  assert.equal(canonicalIsbn('043942089X'), '9780439420891');
  assert.equal(canonicalIsbn('043942089x'), '9780439420891', 'lower case too');
});

test('hyphens and spaces are presentation, not data', () => {
  assert.equal(canonicalIsbn('978-0-441-01359-3'), '9780441013593');
  assert.equal(canonicalIsbn('0-441-01359-7'), '9780441013593');
  assert.equal(canonicalIsbn('  9780441013593  '), '9780441013593');
});

test('a failed check digit yields null rather than a plausible-looking ISBN', () => {
  // One digit off. Accepting this would let a typo merge two unrelated books
  // into a single edition, overwriting one book's metadata with the other's.
  assert.equal(canonicalIsbn('9780441013594'), null);
  assert.equal(canonicalIsbn('0441013598'), null);
});

test('absent or unusable input yields null', () => {
  for (const v of [null, undefined, '', '   ', '123', 'not-an-isbn', '97804410135931']) {
    assert.equal(canonicalIsbn(v), null, `${JSON.stringify(v)} should not canonicalise`);
  }
});

test('both spellings of one book reduce to the same string', () => {
  // The whole point: these must never produce two editions.
  for (const [ten, thirteen] of [
    ['0441013597', '9780441013593'],
    ['043942089X', '9780439420891'],
    ['0596000278', '9780596000271'],
  ]) {
    assert.equal(canonicalIsbn(ten), canonicalIsbn(thirteen), `${ten} and ${thirteen} must agree`);
  }
});
