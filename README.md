# 📚 Home Library

A self-hosted web app to catalogue the books in your private library. Works from
any phone or desktop browser (Android + iPhone), scans ISBN barcodes with the
camera, auto-fills metadata from Open Library / Google Books, tracks where each
book physically lives, and calculates how many books fit on each shelf.

No native app required — barcode scanning runs client-side in the browser
(via [`html5-qrcode`](https://github.com/mebjas/html5-qrcode)), so it works on
both iOS Safari and Android Chrome.

## Features

- **ISBN scan & auto-fill** — point your camera at the barcode; title, author,
  publisher, page count, cover image, and (when available) physical dimensions
  are pulled from **Open Library** and **Google Books**.
- **Physical description** — hardback/paperback/e-book/audiobook, dust-jacket
  present/missing/N/A, and book dimensions (height × width × spine thickness).
- **Genre / subgenre** with autocomplete from what you've already entered.
- **Shelves as real objects** — model each shelf with room, bookcase, label, and
  dimensions (height × width × depth). Books are placed *on* a shelf.
- **Capacity & reorganizing help** — each shelf shows a fill bar, how much space
  is used vs. free, roughly how many more books fit, and warns about books that
  are **too tall** or **too deep** for the shelf. The book editor warns you if a
  book won't fit the shelf you're assigning it to.
- **Status** — To be read / Reading / Read / Loaned out (with borrower name).
- **Library books** — flag books you've checked out from a public library and
  track the library name and due date.
- **Search & filter** by text, status, room, genre, or shelf (incl. "Unshelved").

## Data model

Two tables in SQLite (`shelves`, `books`) — see [`db.js`](./db.js). All physical
dimensions are stored in **millimetres**. Capacity is computed by treating each
book's *spine thickness* as the width it consumes along the shelf; a book fits
if its height ≤ shelf height and its width ≤ shelf depth.

## Run it

### With Docker (recommended for a homelab)

```bash
docker compose up -d --build
```

Then open `http://<your-server>:3000`. The SQLite database is stored in the
`library-data` Docker volume, so it survives rebuilds. To back it up, copy
`/data/library.db` out of the volume.

### With Node directly

```bash
npm install
npm start            # http://localhost:3000
```

Environment variables:

| Variable  | Default              | Purpose                          |
|-----------|----------------------|----------------------------------|
| `PORT`    | `3000`               | HTTP port                        |
| `DB_PATH` | `./data/library.db`  | SQLite file location             |

## ⚠️ Camera access needs HTTPS

Browsers only allow camera access over **HTTPS** or on `localhost`. On your
homelab, put the app behind a reverse proxy with TLS (Caddy, Traefik, or
Nginx + Let's Encrypt / a Tailscale HTTPS cert) so scanning works from your
phone. You can still add books by typing the ISBN or details manually over plain
HTTP.

Example Caddyfile:

```
library.yourdomain.com {
    reverse_proxy localhost:3000
}
```

## API

All endpoints are under `/api`:

- `GET/POST /books`, `GET/PUT/DELETE /books/:id` — filters: `q`, `status`,
  `room`, `genre`, `format`, `shelf_id` (`none` = unshelved).
- `GET/POST /shelves`, `GET/PUT/DELETE /shelves/:id` — list includes computed
  capacity stats (`used_width_mm`, `free_width_mm`, `fill_pct`, `est_additional`,
  `overfull`, `too_tall`, `too_deep`, `unknown_thickness`).
- `GET /lookup/:isbn` — merged Open Library + Google Books metadata.
- `GET /meta` — distinct rooms, bookcases, genres for autocomplete + counts.

## Notes

- Deleting a shelf keeps its books; they become "Unshelved".
- ISBN dimension data is sparse in both APIs — when it's missing, measure the
  book and enter height/width/thickness by hand to enable shelf-fit calculations.
