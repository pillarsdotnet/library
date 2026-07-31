#!/bin/sh
# Forced command for the Home Library failover key. Installed on BOTH nodes as
# /usr/local/sbin/home-library-failover-peer and named in authorized_keys:
#
#   restrict,command="/usr/local/sbin/home-library-failover-peer" ssh-ed25519 AAAA...
#
# ssh runs this INSTEAD of whatever the client asked for, putting the client's
# request in $SSH_ORIGINAL_COMMAND. Everything below exists to make that request
# untrusted input: it selects one of a fixed list of verbs and nothing else.
# There is no path through here to a shell.
#
# Two rules keep this a real boundary, not a speed bump:
#   * No verb takes a path, a host, an address, or a command. The only argument
#     accepted anywhere is a node name for owner-set, and it is pattern-checked.
#   * VIP and the paths are configured HERE, server-side. If the client could name
#     the VIP it could advertise an arbitrary route into the tailnet; if it could
#     name the file it could read or clobber anything as root.
set -eu

SERVICE=home-library
DATA_DIR=/var/lib/home-library
DB=$DATA_DIR/library.db
OWNER_FILE=$DATA_DIR/OWNER
IMAGE=library.local/home-library:latest
HEALTH_URL=http://127.0.0.1:30800/library/
VIP=192.168.144.1
# Must match ACTIVE_FLAG in failover.sh: the app unit will not start without it.
ACTIVE_FLAG=/run/home-library-active
VIP_DEV=lo
KEEP=10

deny() { echo "failover-peer: refused: $*" >&2; exit 111; }

# Split the request into a verb and at most one argument. Deliberately not `eval`
# and not word-splitting into "$@" — the verb is matched literally below.
set -- ${SSH_ORIGINAL_COMMAND:-}
verb="${1:-}"; arg="${2:-}"

# Exact arity per verb. Without this, a no-argument verb silently ignores trailing
# junk, so `vip-up 10.0.0.0/8` would *run* — the address is fixed server-side so
# nothing bad is advertised, but a caller gets no signal that its argument was
# discarded. Refusing is the honest answer and catches mistakes at the boundary.
case "$verb" in
  # "<node> <generation>" — the generation is what decides which copy is
  # authoritative, so it is written here alongside the node name.
  owner-set) [ $# -eq 3 ] || deny "owner-set takes exactly two arguments: <node> <generation>" ;;
  *)         [ $# -eq 1 ] || deny "$verb takes no arguments" ;;
esac

case "$verb" in
  hostname)   hostname -s ;;

  owner-get)  cat "$OWNER_FILE" 2>/dev/null || echo none ;;

  owner-set)
    # The only client-supplied values that reach a file. Both are pattern-checked
    # against anchored character classes, and written with printf so nothing is
    # interpreted as shell either way.
    gen="${3:-}"
    case "$arg" in
      "" ) deny "owner-set needs a node name" ;;
      *[!A-Za-z0-9._-]* ) deny "owner-set: illegal node name" ;;
    esac
    case "$gen" in
      "" ) deny "owner-set needs a generation" ;;
      *[!0-9]* ) deny "owner-set: generation must be digits only" ;;
    esac
    printf '%s %s\n' "$arg" "$gen" > "$OWNER_FILE"
    ;;

  # Newest mtime across the database and its WAL. The main file's mtime lags in
  # WAL mode, so it alone would report a busy database as older than a stale one.
  db-mtime)
    { stat -c %Y "$DB" 2>/dev/null || echo 0
      stat -c %Y "$DB-wal" 2>/dev/null || echo 0
    } | sort -rn | head -1
    ;;

  # Fold the WAL into the main file so one file is a complete copy, and refuse to
  # report success on a corrupt database.
  db-checkpoint)
    [ -f "$DB" ] || exit 0
    docker run --rm -v "$DATA_DIR:/data" "$IMAGE" node -e '
      const db = require("better-sqlite3")("/data/library.db");
      db.pragma("wal_checkpoint(TRUNCATE)");
      const r = db.pragma("integrity_check")[0].integrity_check;
      db.close();
      if (r !== "ok") { console.error("integrity_check: " + r); process.exit(1); }
    ' >/dev/null
    ;;

  # Timestamped COPY so a bad handoff is recoverable. This was `ln -f`, which is
  # not a snapshot: a hardlink is another name for the same inode, and SQLite
  # writes in place, so the whole rotation tracked the live database instead of
  # preserving anything. `.backup` rather than `cp` because it is consistent
  # against a database something still has open.
  db-snapshot)
    [ -f "$DB" ] || exit 0
    command -v sqlite3 >/dev/null || { echo "sqlite3 is required to snapshot" >&2; exit 1; }
    sqlite3 "$DB" ".backup '$DB.$(date -u +%Y%m%dT%H%M%SZ)'"
    ls -1t "$DB".*Z 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done
    ;;

  db-send)    [ -f "$DB" ] || deny "no database here"; cat "$DB" ;;

  # Stale -wal/-shm beside a replaced database is not untidiness: SQLite can apply
  # a WAL belonging to the previous file. Clear both on the swap.
  db-recv)
    cat > "$DB.incoming"
    [ -s "$DB.incoming" ] || { rm -f "$DB.incoming"; deny "received an empty database"; }
    mv -f "$DB.incoming" "$DB"
    rm -f "$DB-wal" "$DB-shm"
    chmod 644 "$DB"
    ;;

  # Bring this node fully up as the active one, through its OWN units.
  #
  # This exists because starting only the app was not enough. The handoff used to
  # start the app directly and assign the address by verb, which left this node's
  # home-library-db and home-library-vip units INACTIVE while it was in fact serving.
  # systemd's view then disagreed with reality, and the consequence only showed up
  # later: this node's next shutdown ran no ExecStop at all, so it handed nothing
  # back and left the app dead with the address still pointing at it.
  #
  # Starting the units instead means db-claim runs here. It finds this node already
  # owns the database (the initiator set that before calling this), keeps the local
  # copy, and ends with all three units active — so the next shutdown hands over
  # properly. The cost is one redundant checkpoint and generation bump per handoff.
  #
  # The app unit's ConditionPathExists is satisfied in time because db-claim creates
  # the activity flag and is ordered Before= the app.
  takeover)
    systemctl start home-library-db "$SERVICE" home-library-vip
    ;;

  # Manual use only. Starts just the app, bypassing the units — which is exactly the
  # state described above, so do not use this for a handoff.
  svc-start)
    : > "$ACTIVE_FLAG"
    systemctl start --job-mode=ignore-dependencies "$SERVICE"
    ;;

  # `docker run` exits non-zero when its container is killed, so an intentional
  # stop still lands the unit in "failed". Clear it, or the standby node sits
  # permanently failed between handoffs and real failures stop standing out.
  svc-stop)
    systemctl stop "$SERVICE"
    systemctl reset-failed "$SERVICE" 2>/dev/null || true
    rm -f "$ACTIVE_FLAG"
    ;;

  health)     curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true ;;

  vip-up)
    ip addr show dev "$VIP_DEV" | grep -q "inet $VIP/32" || ip addr add "$VIP/32" dev "$VIP_DEV"
    tailscale set --advertise-routes="$VIP/32"
    ;;
  vip-down)
    tailscale set --advertise-routes=
    ip addr del "$VIP/32" dev "$VIP_DEV" 2>/dev/null || true
    ;;

  vip-state)
    if ip addr show dev "$VIP_DEV" | grep -q "inet $VIP/32"; then echo assigned; else echo no; fi
    ;;

  *) deny "unknown verb '${verb:-<empty>}'" ;;
esac
