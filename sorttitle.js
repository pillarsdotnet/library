// Sort keys for filing books the way a librarian does: titles with the
// leading article skipped, authors surname-first.

// Normalize a title for alphabetical sorting: drop a leading article
// (A / An / The) and any leading punctuation/whitespace, case-insensitively.
// "The Winter of the Witch" -> "winter of the witch".
export function sortTitle(title) {
  // Drop leading punctuation/quotes/whitespace first, so `"The Nightmare…"` still
  // has its article recognized.
  let s = String(title == null ? '' : title).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const stripped = s.replace(/^(a|an|the)\s+/i, '');
  // Don't reduce a title to nothing (e.g. a title that is literally "The").
  if (stripped) s = stripped;
  // Trim leading/trailing punctuation (e.g. surrounding quotes) from the key.
  return s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '').toLowerCase();
}

// Generational suffixes say nothing about where a name files.
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv)$/i;
// Particles that belong to the surname: "Ursula K. Le Guin" files under
// "Le Guin", not "Guin".
const SURNAME_PARTICLES = new Set([
  'da', 'das', 'de', 'del', 'della', 'den', 'der', 'di', 'dos', 'du',
  'la', 'le', 'st', 'ten', 'ter', 'van', 'von',
]);

// Words keep internal apostrophes and hyphens (O'Brien, Smith-Jones);
// initials lose their dots so "K." and "K" file together.
const nameWords = (s) => s.toLowerCase().split(/\s+/)
  .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, ''))
  .filter(Boolean);

// Normalize an authors string for alphabetical sorting: the primary (first
// listed) author, filed surname first — then, as tie-breakers, the primary's
// given and middle names, any generational suffix, and the secondary authors.
// "Frank Herbert, Kevin J. Anderson" -> "herbert frank kevin j anderson".
// Names are stored forward ("First Last"); a lone name ("Homer") is its own
// surname.
export function sortAuthor(authors) {
  const [primary, ...rest] = String(authors == null ? '' : authors).split(/[,;]/);
  const words = nameWords(primary);
  const suffix = [];
  while (words.length > 1 && NAME_SUFFIX.test(words[words.length - 1])) suffix.unshift(words.pop());
  if (!words.length) return '';
  const last = [words.pop()];
  while (words.length > 1 && SURNAME_PARTICLES.has(words[words.length - 1])) last.unshift(words.pop());
  return [...last, ...words, ...suffix, ...rest.flatMap(nameWords)].join(' ');
}
