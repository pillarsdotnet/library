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

| Variable    | Default              | Purpose                                             |
|-------------|----------------------|-----------------------------------------------------|
| `PORT`      | `3000`               | HTTP port                                           |
| `DB_PATH`   | `./data/library.db`  | SQLite file location                                |
| `BASE_PATH` | `` (root)            | Sub-path to serve under, e.g. `/library`            |
| `GOOGLE_BOOKS_API_KEY` | _(none)_  | Optional; raises the Google Books lookup quota      |

### ISBN lookup sources & the Google Books quota

Lookups merge **Open Library** (preferred) and **Google Books**. Open Library
doesn't have every book, and **keyless Google Books has a very small shared daily
quota** — when it's exhausted the API returns HTTP 429, and a book that's only on
Google Books will fail to auto-fill (the app now says it's rate-limited rather
than "not found"). A free Google Books API key raises the quota to ~1,000
lookups/day and makes this reliable.

#### Obtain a key (free, no billing required)

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and sign in.
2. Create a project (top bar → project dropdown → **New Project**), or reuse one.
3. Enable the API: **APIs & Services → Library → search "Books API" → Enable**
   (a.k.a. "Google Books API"). It has a free daily quota; no billing needed.
4. Create the key: **APIs & Services → Credentials → Create credentials → API key**.
   Copy the key. Recommended: **Edit API key → API restrictions → restrict to
   "Books API"** so the key can't be used for anything else.

#### Install the key

**Kubernetes (homelab):** store it in a secret the Deployment already references
(via an optional `secretKeyRef`, so the app also runs fine without one):

```bash
kubectl -n home-library create secret generic home-library-secrets \
  --from-literal=google-books-api-key=YOUR_KEY
kubectl -n home-library rollout restart deploy/home-library
```

To rotate later: `kubectl -n home-library delete secret home-library-secrets`,
recreate it, then roll out again.

**Docker / local:** pass it as an environment variable:

```bash
GOOGLE_BOOKS_API_KEY=YOUR_KEY npm start
# docker run: add  -e GOOGLE_BOOKS_API_KEY=YOUR_KEY
```

`BASE_PATH` makes the whole app (UI + API) live under a sub-path. The server
injects a matching `<base href>` so every asset and API call is relative — the
app works at `/` or under any prefix with no rebuild.

### On the homelab Kubernetes cluster

This repo is deployed to the k8s cluster and served at
`http://homelab/library/` (also `http://10.0.0.2/library/` and
`http://100.84.6.113/library/`). The manifests are in [`k8s/`](./k8s).

Because the cluster has no image registry, ingress controller, or dynamic
storage, the deployment:

- runs the app as a Deployment pinned to the `homelab` node, with `BASE_PATH=/library`;
- persists the SQLite DB on a node `hostPath` (`/var/lib/home-library`);
- exposes it via a NodePort (`30800`);
- is fronted by the node's existing nginx, which proxies `location /library/`
  to the NodePort (see [`deploy/nginx-library.conf`](./deploy/nginx-library.conf)).

Deploy / update:

```bash
# 1. Build and import the image into the homelab node's containerd (no registry):
docker build -t library.local/home-library:1.0.0 .
docker save library.local/home-library:1.0.0 | ssh homelab 'sudo ctr -n k8s.io images import -'

# 2. Apply manifests:
kubectl apply -f k8s/home-library.yaml

# 3. (first time only) add the nginx proxy snippet to the homelab node and reload:
#    see deploy/nginx-library.conf, then: sudo nginx -t && sudo systemctl reload nginx

# Roll out a new image build (same tag) by restarting the deployment:
kubectl -n home-library rollout restart deploy/home-library
```

## HTTPS (for camera scanning)

Browsers only allow camera access over **HTTPS** or on `localhost`, so barcode
scanning needs an HTTPS URL. This deployment uses a **Tailscale cert** via
`tailscale serve`, which terminates TLS and proxies to the node's nginx:

```bash
# One-time: enable "HTTPS Certificates" in the Tailscale admin console
# (https://login.tailscale.com/admin/dns), then on the homelab node:
sudo tailscale serve --bg --https=443 http://127.0.0.1:80
```

Tailscale obtains and auto-renews the Let's Encrypt cert; no cron needed. The
app is then available over HTTPS at:

**https://homelab.dala-hue.ts.net/library/**  (reachable from any device on the tailnet)

A Tailscale cert is only valid for the node's MagicDNS name, so the bare IPs
(`10.0.0.2`, `100.84.6.113`) and the short name `homelab` stay on plain **HTTP**
— fine for browsing on the LAN, but use the `ts.net` URL from your phone when you
want to scan. Because Tailscale proxies to nginx over http, the nginx `/library`
redirect uses `absolute_redirect off` so it preserves the client's scheme.

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
