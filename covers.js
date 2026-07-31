// Cache-busting token for an inline (data:) cover image.
//
// The URL a client is given for a cover must change when the image changes, or a
// browser holding a cached copy goes on showing the old photo after a new one is
// saved — which looks exactly like the save having failed.
//
// The token is derived from the image, but it is STORED beside it rather than
// computed on read. Computing it per request means reading the base64 back out of
// the database on every listing, and measurement says that is the single most
// expensive thing the list endpoint does: 1.89 ms/page with the image columns
// against 0.79 ms without, on 20 rows. Nor can it be computed in SQL and left
// there — `length()` walks the whole overflow chain to count characters and costs
// exactly as much as fetching the bytes.
export const coverToken = (s) => {
  let h = 0x811c9dc5;                       // FNV-1a, 32-bit
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
};
