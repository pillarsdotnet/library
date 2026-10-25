# Installing Home Library

How to install, run and operate the app. For what it does, see the
[README](README.md); for working on the code, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Run it

### From the Debian registry

On Ubuntu 26.04 (`resolute`) or 26.10 (`stonking`), install the Debian package
from the
[package registry](https://forgejo.bobbalisa.org/pillarsdotnet/-/packages) on
`forgejo.bobbalisa.org`:

```sh
sudo install -d /etc/apt/keyrings
curl -fsS https://forgejo.bobbalisa.org/api/packages/pillarsdotnet/debian/repository.key |
  sudo tee /etc/apt/keyrings/forgejo-bobbalisa.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/forgejo-bobbalisa.asc] https://forgejo.bobbalisa.org/api/packages/pillarsdotnet/debian $(lsb_release -cs) main" |
  sudo tee /etc/apt/sources.list.d/forgejo-bobbalisa.list > /dev/null
sudo apt update
sudo apt install home-library
```

The package runs the app as a `systemd` service, started on demand through a
Unix socket, and ships an `nginx` snippet and an Apache configuration that serve
it under `/library/`. Its data lives in `/var/lib/home-library`, and its
settings in `/etc/home-library/home-library.env`. The registry also carries the
newer `libvips` it needs, and on 26.04 the Node.js 24 that the archive lacks.
`/usr/share/doc/home-library/README.Debian` covers the web server setup.

To run one library on two machines, with exactly one of them accepting changes
at a time, add `home-library-failover` (26.10 only). It hands the
live database and covers between the two, moves a `Tailscale` floating address
with them, and can point a public DNS name at whichever machine is serving.
Nothing changes until `home-library-failover enable`; see
`/usr/share/doc/home-library-failover/README.Debian`.

### With Docker

```bash
docker compose up -d --build
```

Then open `http://<your-server>:3000`. The image is built locally from the
[`Dockerfile`](Dockerfile) (Debian slim; the `zoneinfo` files are included, so
due dates follow `TZ` instead of silently meaning UTC). The SQLite database is
stored in the `library-data` Docker volume, so it survives rebuilds. To back it
up, copy `/data/library.db` **and the `covers/` directory beside it** out of
the volume — neither is whole without the other.

The scripts in [`bench/`](bench/) compare any two images (memory, CPU per
request, image size), such as two releases, or slim with and without
`MALLOC_ARENA_MAX=2`.

### With Node directly

```bash
npm install
npm start            # http://localhost:3000
```

Environment variables:

| Variable                    | Default                       | Purpose                                                                                                                 |
| --------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`                      | `3000`                        | HTTP port, when neither of the next two applies                                                                         |
| `SOCKET_PATH`               | _(none)_                      | Listen on this Unix socket instead of `PORT`, for a web server in front; a stale socket file there is removed first     |
| `SOCKET_MODE`               | _(`umask`)_                   | Octal mode for that socket, e.g. `660` so the web server's group can connect                                            |
| `LISTEN_FDS`                | _(set by `systemd`)_          | A socket handed over by `systemd` socket activation wins over both; the Debian package runs it this way                 |
| `DB_PATH`                   | `./data/library.db`           | SQLite file location                                                                                                    |
| `BASE_PATH`                 | `` (root)                     | Sub-path to serve under, e.g. `/library`                                                                                |
| `GOOGLE_BOOKS_API_KEY`      | _(none)_                      | Optional; raises the Google Books lookup quota                                                                          |
| `OPENLIBRARY_ACCESS_KEY`    | _(none)_                      | Sign-in **off** only: the keys contributions are sent with. With sign-in on, each user adds their own                   |
| `OPENLIBRARY_SECRET_KEY`    | _(none)_                      | Paired with the access key                                                                                              |
| `OPENLIBRARY_ALLOW_IMPORT`  | _(unset)_                     | `true` allows creating records for books Open Library lacks                                                             |
| `OPENLIBRARY_SOURCE_PREFIX` | `pillarsdotnet_library`       | `source_records` prefix for imports; set it empty to stamp nothing and import nothing                                   |
| `GOOGLE_CLIENT_ID`          | _(none)_                      | Google `OAuth` client; **setting this and the secret is what turns sign-in on**                                         |
| `GOOGLE_CLIENT_SECRET`      | _(none)_                      | Paired with the client id                                                                                               |
| `AUTH_ALLOWED_FILE`         | `<DB dir>/allowed-emails.txt` | Read **once**, when the first library is created: its addresses become that library's members                           |
| `SESSION_SECRET`            | _(new each boot)_             | Signs session cookies and encrypts users' Open Library keys; set it, or a restart signs everyone out and loses the keys |
| `SESSION_IDLE_DAYS`         | `10`                          | Sign-in expires after this long **without a visit**; every visit pushes it out (floored at 1 day)                       |
| `OAUTH_REDIRECT_URI`        | _(from the request)_          | Override when the public URL is not what the app sees                                                                   |
| `PUBLIC_ORIGIN`             | _(from the request)_          | Scheme and host to build the redirect URI and emailed links from                                                        |
| `SMTP_USER`                 | _(none)_                      | Gmail address the new-library email is sent from; **setting this and the password turns it on**                         |
| `SMTP_PASSWORD`             | _(none)_                      | A Gmail app password for `SMTP_USER`                                                                                    |
| `SMTP_HOST`                 | `smtp.gmail.com`              | Submission server; must offer STARTTLS                                                                                  |
| `SMTP_PORT`                 | `587`                         | Submission port                                                                                                         |
| `TRUST_PROXY`               | _(off)_                       | `true` behind `nginx`, so `X-Forwarded-Proto` decides the Secure cookie flag                                            |
| `LOOKUP_TTL_DAYS`           | `30`                          | How long a found lookup stays cached (floored at 1 day)                                                                 |
| `LOOKUP_NEGATIVE_TTL_HOURS` | `24`                          | How long a "not found" stays cached (floored at 24h)                                                                    |

`BASE_PATH` makes the whole app (UI + API) live under a sub-path. The server
injects a matching `<base href>` so every asset and API call is relative — the
app works at `/` or under any prefix with no rebuild.

## Two-node failover (optional)

`deploy/failover.sh` and the two units beside it move the app between two nodes, so
exactly one node is writable at a time. **Both nodes run identical units**, so either
one hands the database over when it shuts down — without that, shutting down whichever
node happens to be active strands the only authoritative copy on a powered-off box. The SQLite database
travels with the active node, and a floating address follows it, so clients keep one
URL. It is a **graceful handoff, not high availability** — the shutdown half only
runs on an orderly shutdown, so a power cut leaves the preferred node owning the
database and the standby deliberately does _not_ self-promote.

Which copy is authoritative is decided by an owner marker holding a node name and a
**generation counter**, written on both nodes at every handoff. A push or pull is
refused if the destination's generation is higher, i.e. a later handoff produced it.
File timestamps are logged but never gate a handoff: opening a SQLite database
updates its `mtime`, so a standby started for any reason would otherwise look newer
than the rightful owner and block the next legitimate failover.

Two units bracket the app so that `systemd` — not the script — sequences everything:

| Unit               | Ordering              | Boot                                       | Shutdown                       |
| ------------------ | --------------------- | ------------------------------------------ | ------------------------------ |
| `home-library-db`  | `Before=home-library` | runs first, puts the database in place     | runs last, app already stopped |
| `home-library-vip` | `After=home-library`  | runs last, claims the address once healthy | runs first, withdraws it       |

A hook must never run `systemctl` against the app it brackets — asking `systemd` to
run a job while it is waiting on your `ExecStop` deadlocks until the timeout.

A handoff must also start the receiving node's **own units**, not just its app.
Starting the app directly leaves that node's units inactive while it is serving, and
`systemd` then runs no `ExecStop` on its next shutdown — so it hands nothing back.

The app unit must also **`Requires=`** the database unit on the preferred node.
Ordering alone is not a requirement: without it the app starts even after the
handoff deliberately refused, serves the stale local copy, and the address unit
advertises it — turning "refuse to serve stale data" into "serve stale data as
authoritative".

`PREFERRED` (default `homelab`) breaks the tie, because identical units otherwise
mean a standby that reboots would pull the database from a perfectly healthy active
node and take over. Only the preferred node reclaims on boot; the other comes up
active solely if it already owns the database, i.e. the preferred node handed over
and has not returned. Set it in both units' drop-ins on **both** nodes, alongside
`PEER` and `VIP`; for a public node with a cold backup, prefer the public node, and
promote the backup by hand with `failover.sh to-local` if it has to take over.

Only the node that **owns** the database hands anything over. A standby's database
unit is active too, so its shutdown runs the same `db-release`, and the generation
guard cannot stop it: every handoff writes the same generation to both nodes, and
an equal one passes. So `db-release` checks the owner marker first and does nothing
on a node that does not own the database; without that, a standby going down
pushed its stale copy over the live one.

That same leftover-active unit is why the receiving node's `takeover` verb runs
`db-claim` itself when `home-library-db` is already active. Starting an active unit
runs nothing, so the activity flag was never written and the app was skipped.

`failover.sh to-local` and `to-remote` run each step as a fresh invocation of the
script. The steps inherit the lock the outer run took, rather than taking it again.

A standby boot is a normal outcome, not an error, so it must not leave failed units.
`db-claim` writes an activity flag under `/run` only on the node that should be
running, and the app and address units test it with `ConditionPathExists`, which
makes `systemd` **skip** them cleanly. The flag lives in `/run` deliberately: a reboot
clears it, so every boot has to decide afresh.

Cover images move with the database, through the `covers-send` / `covers-recv`
verbs — they are files beside it, and the two are worthless apart: a row
naming a missing file is a broken picture, and an image nothing refers to is
landfill.

Before a handoff replaces a database, the old one is kept as a timestamped
**copy** (`.backup`, so it is consistent even against an open database), ten
generations deep. Covers are _not_ snapshotted: they are named by the hash of
their content and never change once written — a new photo is a new file — so a
restored database of any recent vintage still finds its images. These were once hard links, which is not a snapshot at all — a
hard link is another name for the same `inode`, and SQLite writes in place, so every
"generation" tracked the live file and the rotation preserved nothing while
looking exactly like a working backup rotation.

Requirements: `ssh` between the nodes with no password, for a key restricted by
`command=` to `deploy/failover-peer.sh` (a fixed verb list, so the credential cannot
do more than its job), and if the floating address is a mesh-VPN route, an
auto-approver for it — otherwise the standby's advertisement is unapproved and the
address points nowhere for exactly as long as it takes someone to notice.

### Hourly copy to the standby

A handoff only moves the database when someone shuts a node down in an orderly
way. `deploy/db-sync.sh`, run hourly from `/etc/cron.d/home-library-db-sync`,
covers the other case: a node that dies outright then costs at most an hour.

Install it on **both** nodes. It exits immediately unless the node holds the
activity flag, so it follows the database through a handoff rather than naming a
fixed master, and it never pulls — two diverged SQLite databases cannot be merged
afterwards.

It sends the covers directory in the same run — `rsync` is the right tool for that
precisely because almost none of it changes between runs — and writes to
`<data dir>/standby/` on the peer, deliberately **not** to the peer's own
`library.db`: that would drive past the generation interlock, which
exists precisely to refuse replacing a copy a later handoff produced. Restoring
from it is a deliberate act, not something the hourly job can do by accident.

Transport is a second key, pinned on the far side to `rrsync -wo <dir>` so it can
only write and only inside that directory. The failover key is not reused — it is
pinned to the verb script and has no path to `rsync`, which is the point of it.

Per node, `/etc/default/home-library-db-sync` holds `PEER=<other node>`. A run
where nothing has been written since the last one does no work at all; a peer that
is merely offline logs to the journal and exits 0, while anything else fails
loudly.

## HTTPS (for camera scanning)

Browsers only allow camera access over **HTTPS** or on `localhost`, so barcode
scanning needs an HTTPS URL. Any TLS front end works — what matters is that the
certificate is one the phone already trusts, so a self-signed cert is not enough.

Two approaches that need no public DNS:

- **A mesh VPN that issues certs for its own names.** `Tailscale`, for example, can
  obtain and auto-renew a Let's Encrypt cert for a node's MagicDNS name and
  terminate TLS in front of `nginx`:

  ```bash
  # One-time: enable "HTTPS Certificates" in the admin console, then on the node:
  sudo tailscale serve --bg --https=443 http://127.0.0.1:80
  ```

  The app is then reachable at `https://<node>.<tailnet>.ts.net/library/` from any
  device on the VPN.

- **A real domain plus `certbot`**, if the node has one, terminating TLS in `nginx`
  directly.

Such a certificate is only valid for that **one name**, so bare IP addresses and
short hostnames stay on plain HTTP — fine for browsing on a trusted LAN, but use
the certificate's name from a phone when you want to scan.

If TLS is terminated ahead of `nginx` and passed onward over `http`, keep
`absolute_redirect off` on the `/library` redirect (as
[`deploy/nginx-library.conf`](./deploy/nginx-library.conf) does) so the redirect
preserves the client's scheme instead of forcing `https` clients back to `http`.

## API

All endpoints are under `/api`:

- `GET/POST /books`, `GET/PUT/DELETE /books/:id` — filters: `q`, `status`,
  `room`, `genre`, `format`, `shelf_id` (`none` = no shelf).
- `GET/POST /shelves`, `GET/PUT/DELETE /shelves/:id` — list includes computed
  capacity stats (`used_width_mm`, `free_width_mm`, `fill_pct`, `est_additional`,
  `overfull`, `too_tall`, `too_deep`, `unknown_thickness`).
- `PUT /bookcases` — body `{ from: { room, bookcase }, room, bookcase }`: gives
  every shelf in that bookcase the new room and bookcase names. A blank name
  means none.
- `POST /bookcases` — same body: copies every shelf in that bookcase, without
  its books, under the new names. `409` if a bookcase by those names exists.
- `POST /series/:id/genres` — body `{ genre_ids: [...] }`: adds those genres to
  every book in the series (additive; nothing is removed). Backs the two
  copy-across-the-series prompts in the book dialog.
- `GET /lookup/:isbn` — merged Open Library + `ISBNdb` + Google Books +
  Library of Congress + Barnes & Noble metadata, each later source filling
  only the blanks the earlier ones left.
- `GET/PUT /library/keys` — the library's own Google Books and `ISBNdb` keys
  (founder only; answers carry hints, never the keys).
- `GET /meta` — distinct rooms, bookcases, genres for autocomplete + counts.
