// The ISBN canonicaliser is what stops one edition becoming two rows, so the
// property that matters most is the last test: both spellings of a book must
// reduce to the same string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIsbn, canonicalLccn } from '../isbn.js';

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

// ─── Library of Congress Control Numbers ─────────────────────────────────────

test('an LCCN is normalized the way the Library of Congress normalizes it', () => {
  // The serial after the hyphen is zero-padded to six digits.
  assert.equal(canonicalLccn('68-12345'), '68012345');
  assert.equal(canonicalLccn('75-425165'), '75425165');
  assert.equal(canonicalLccn('2001-12345'), '2001012345');
  // Alphabetic prefixes survive, lowercased.
  assert.equal(canonicalLccn('AGR68-1234'), 'agr68001234');
  // Blanks are dropped; a revision suffix after a slash is dropped.
  assert.equal(canonicalLccn(' 75-425165//r75 '), '75425165');
  // An already-normalized number passes through.
  assert.equal(canonicalLccn('68012345'), '68012345');
});

test('the hyphen is optional: the year digits settle where the serial starts', () => {
  // Two year digits, the rest is the serial — a phone's numeric keypad has
  // no hyphen, so the number types as it reads.
  assert.equal(canonicalLccn('6812345'), '68012345');
  assert.equal(canonicalLccn('681234'), '68001234');
  assert.equal(canonicalLccn('agr681234'), 'agr68001234');
  // Nine or ten digits beginning "20" are a 2001-or-later four-digit year.
  assert.equal(canonicalLccn('200112345'), '2001012345');
  assert.equal(canonicalLccn('2001012345'), '2001012345');
  // Eight digits beginning "20" read literally — 1920, not an unpadded 2008.
  // The hyphen is what distinguishes "2008-1234".
  assert.equal(canonicalLccn('20081234'), '20081234');
  assert.equal(canonicalLccn('2008-1234'), '2008001234');
});

test('an LCCN that is not one yields null', () => {
  for (const bad of ['', null, undefined, '12', '68-', '68-12x45', '9780441013593', 'abcd68012345']) {
    assert.equal(canonicalLccn(bad), null, `${bad} should not be an LCCN`);
  }
  // Ten digits that do not begin "20" would need an eight-digit serial —
  // that is a mistyped ISBN-10, not an LCCN.
  assert.equal(canonicalLccn('0441013598'), null);
});

test('a string can read as both, so the ISBN check must run first', () => {
  // A VALID ISBN-10 beginning "20" also matches the LCCN shape — it has no
  // way to know. Callers resolve the ambiguity by asking canonicalIsbn first.
  const both = '2036850001';
  assert.notEqual(canonicalLccn(both), null);
  // And a short digit string is an LCCN candidate even when it was meant as
  // a partial ISBN; only the full ISBN's check digit outranks it.
  assert.equal(canonicalLccn('6812345'), '68012345');
  assert.equal(canonicalIsbn('0441013597'), '9780441013593');
});
