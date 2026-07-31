#!/bin/sh
# Hourly one-way copy of the live database to the failover node, so a node that
# dies between handoffs costs at most an hour rather than everything.
#
# Installed as /usr/local/sbin/home-library-db-sync on BOTH nodes and driven by
# /etc/cron.d/home-library-db-sync. It is the ACTIVE node's job, and which node
# that is changes — so rather than being installed on "the master", it runs
# everywhere and returns immediately unless this node holds the activity flag.
# A handoff therefore moves the sync with the database, without anyone editing
# a crontab.
#
# WHERE IT WRITES, AND WHY NOT ONTO library.db
# The copy lands in $DATA_DIR/standby/library.db on the peer, never on the peer's
# own library.db. Overwriting that would drive straight through the interlock the
# failover script is built around: assert_generation_ok() refuses to replace a
# copy that a LATER handoff produced, and an hourly job writing behind its back
# could destroy a standby copy that is legitimately newer, or land in the middle
# of a handoff that is busy moving the same file. This is a disaster copy, not a
# replication channel: restoring from it is a deliberate act.
#
# ONE-WAY, ALWAYS
# Two SQLite databases cannot be merged after the fact — AUTOINCREMENT ids collide
# and deletions leave nothing behind to replay — so this only ever pushes from the
# node that owns the database. Nothing here ever pulls.
set -eu

CONF=/etc/default/home-library-db-sync
# shellcheck source=/dev/null
[ -r "$CONF" ] && . "$CONF"

PEER="${PEER:?set PEER in $CONF}"
PEER_PORT="${PEER_PORT:-65432}"
# A key of its own, NOT the failover key: that one is pinned to the failover verb
# script and has no path to rsync. This one is pinned on the far side to
# `rrsync -wo <dir>`, which can only write, and only inside that directory.
KEY="${KEY:-/root/id_homelibrary_sync}"
DATA_DIR="${DATA_DIR:-/var/lib/home-library}"
DB="${DB:-$DATA_DIR/library.db}"
ACTIVE_FLAG="${ACTIVE_FLAG:-/run/home-library-active}"
STATE_DIR="${STATE_DIR:-$DATA_DIR/.sync}"
LOCK=/run/home-library-db-sync.lock

log() { logger -t home-library-db-sync -- "$@"; }

# Only the node holding the database has anything authoritative to send.
[ -e "$ACTIVE_FLAG" ] || exit 0
[ -f "$DB" ] || exit 0

# An hour is long enough that overlap should be impossible, which is exactly why
# it is worth refusing rather than assuming.
exec 9>"$LOCK"
flock -n 9 || { log "another sync is still running — skipping"; exit 0; }

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# The no-edits case, which is most of them: fingerprint the database AND its WAL
# and stop before doing any work at all. In WAL mode a commit lands in -wal and
# the main file can sit unchanged for a long time, so hashing library.db alone
# would call a busy hour quiet. Cheap enough to run every hour on 12 MB, and it
# means an idle library costs no snapshot, no ssh, and no transfer.
fingerprint() {
  { sha256sum "$DB"; sha256sum "$DB-wal" 2>/dev/null || true; } | awk '{ print $1 }' | tr -d '\n'
}
now=$(fingerprint)
if [ "$now" = "$(cat "$STATE_DIR/last-synced" 2>/dev/null || echo none)" ]; then
  exit 0
fi

# Is the peer actually there? ssh exits 255 when IT could not connect, as opposed
# to a remote command's own status — so 255 is the honest signal for "offline",
# and this is the one failure that must stay quiet: the standby being down is a
# known state, not an incident, and an hourly cron mail about it trains people to
# ignore cron mail. It still reaches the journal, because silence and invisibility
# are not the same thing. (An auth failure also lands here; the log line is worded
# so a permanent one is recognisable when someone does look.)
set +e
ssh -i "$KEY" -p "$PEER_PORT" -o BatchMode=yes -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new "root@$PEER" true >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -eq 255 ]; then
  log "peer $PEER unreachable or refusing the sync key — skipping this run"
  exit 0
fi

# rsync cannot be pointed at a live SQLite database: it copies while writes land,
# and what arrives is a file torn across a commit. Snapshot first — `.backup` is
# consistent against an open database, `cp` is not — and only ever ship the
# snapshot. Verified before sending, so a corrupt source is caught here instead of
# quietly becoming a corrupt disaster copy.
SNAP="$STATE_DIR/library.db"
rm -f "$SNAP"
sqlite3 "$DB" ".backup '$SNAP'"
[ "$(sqlite3 "$SNAP" 'PRAGMA integrity_check;')" = ok ] \
  || { log "ERROR: snapshot of $DB failed integrity_check — not sending"; exit 1; }

# Destination is relative: rrsync on the far side confines it to the directory
# named in authorized_keys, so this cannot address anything else on that host.
# Past this point a failure is a real one and is allowed to be noisy.
rsync -a --checksum \
  -e "ssh -i $KEY -p $PEER_PORT -o BatchMode=yes -o ConnectTimeout=10" \
  "$SNAP" "root@$PEER:library.db"

printf '%s' "$now" > "$STATE_DIR/last-synced"
log "synced $(stat -c %s "$SNAP") bytes to $PEER:$DATA_DIR/standby/library.db"
