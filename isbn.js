// Canonical ISBN handling, plus the Library of Congress Control Number — the
// identifier a pre-ISBN book (US publishers adopted ISBNs around 1970) offers
// instead.
//
// An edition is identified by its ISBN, but the same edition is written two ways:
// the pre-2007 10-digit form and the 13-digit form. `0441013597` and
// `9780441013593` are the same book. Stored verbatim, they produce two edition
// rows and the copies never merge — which is the whole failure this module
// exists to prevent. Everything that reaches the database goes through
// canonicalIsbn() first, so there is exactly one spelling per edition.
//
// Check digits are verified rather than trusted. A mistyped ISBN that still
// looks like an ISBN would otherwise merge two unrelated books into one edition,
// silently overwriting one book's metadata with the other's. When the check
// digit fails we return null, which means "no usable ISBN": the copy gets an
// edition to itself and nothing is merged on a value we could not verify.

// ISBN-10: sum of digit × (10, 9, … 1) must be ≡ 0 (mod 11). The final position
// may be 'X', meaning 10.
function isbn10Valid(s) {
  if (!/^[0-9]{9}[0-9X]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const c = s[i];
    sum += (c === 'X' ? 10 : Number(c)) * (10 - i);
  }
  return sum % 11 === 0;
}

// ISBN-13: sum of digit × alternating 1, 3 must be ≡ 0 (mod 10).
function isbn13Valid(s) {
  if (!/^[0-9]{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

function isbn13CheckDigit(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/**
 * Reduce a Library of Congress Control Number to its normalized form, the
 * way the Library of Congress itself normalizes them: blanks dropped, any
 * revision suffix after a slash dropped ("75-425165//r75"), and the serial
 * after the hyphen zero-padded to six digits, so "68-12345" becomes
 * "68012345". Pre-2001 numbers are eight digits with an optional alphabetic
 * prefix of up to three letters; 2001 onward they are ten.
 *
 * Returns null for anything else. An LCCN has no check digit, so a ten-digit
 * string can read as either an LCCN or a mistyped ISBN-10 — callers must try
 * canonicalIsbn() FIRST and treat only its rejects as candidate LCCNs.
 */
export function canonicalLccn(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).toLowerCase().replace(/\s+/g, '');
  const slash = s.indexOf('/');
  if (slash !== -1) s = s.slice(0, slash);
  const hyphen = s.indexOf('-');
  if (hyphen !== -1) {
    const serial = s.slice(hyphen + 1);
    if (!/^[0-9]{1,6}$/.test(serial)) return null;
    s = s.slice(0, hyphen) + serial.padStart(6, '0');
  }
  return /^[a-z]{0,3}([0-9]{8}|[0-9]{10})$/.test(s) ? s : null;
}

/**
 * Reduce any ISBN spelling to the canonical 13-digit form.
 *
 * Returns null for anything that is not a verifiable ISBN — empty, malformed,
 * or failing its check digit. Callers must treat null as "this copy has no
 * ISBN to merge on", never as an error.
 */
export function canonicalIsbn(raw) {
  if (raw === null || raw === undefined) return null;
  // Hyphens and spaces are presentation; 'x' is a check digit, not a letter.
  const s = String(raw).replace(/[\s-]/g, '').toUpperCase();
  if (isbn13Valid(s)) return s;
  if (isbn10Valid(s)) {
    const body = `978${s.slice(0, 9)}`;
    return body + isbn13CheckDigit(body);
  }
  return null;
}
