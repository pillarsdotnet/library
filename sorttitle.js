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
