#!/bin/sh
# Hand the live Home Library between two nodes, moving the SQLite database with
# it so exactly one node is ever writable.
#
#   failover.sh to-local    this node takes over   (run at startup)
#   failover.sh to-remote   the peer takes over    (run at shutdown)
#   failover.sh status      show who owns the app
#
# WHY AN OWNER MARKER
# The obvious version of this — "on startup, copy the peer's database here" —
# silently destroys data. If this node died without running its shutdown hook the
# peer never took over, so the peer's copy is STALE, and copying it back would
# overwrite newer local data. So ownership is explicit: OWNER_FILE names the node
# that last took over, and a pull only happens when the *other* side owns it.
# Whoever owns the database is the only node whose copy is authoritative.
#
# WHAT THIS IS NOT
# The shutdown half only runs on an orderly shutdown. A power cut or panic leaves
# ownership with the dead node, and the peer will NOT self-promote — deliberately,
# because a node that cannot be reached also cannot be proven quiescent, and
# promoting on a guess is how both sides end up writable and diverge. Recover by
# running `failover.sh to-local` on the survivor, which is an explicit decision.
#
# THE FLOATING IP
# Tailscale has no floating-address primitive in this version, so the VIP is a /32
# advertised as a subnet route by whichever node is active, and removed when it is
# not. Two one-time prerequisites, or the VIP silently does not route:
#   1. Approve the route for BOTH nodes in the admin console, or add an
#      autoApprovers entry for it to the tailnet policy file.
#   2. Clients must accept routes (`tailscale set --accept-routes`). Phones do by
#      default; Linux desktops do not.
set -eu

# ─── configuration ──────────────────────────────────────────────────────────────
# The peer's hostname (MagicDNS short name is fine) and sshd port.
PEER="${PEER:?set PEER to the peer's hostname}"
PEER_PORT="${PEER_PORT:-65432}"
# Identity for the restricted failover key. The peer's authorized_keys pins this
# key to deploy/failover-peer.sh via command=, so this connection cannot run
# anything but the verbs that script implements.
KEY="${KEY:-/root/id_homelibrary}"

# Floating address, without a prefix length. Must match the VIP compiled into the
# peer's failover-peer.sh — the peer ignores any address we might send.
VIP="${VIP:-192.168.144.1}"

SERVICE="${SERVICE:-home-library}"
DATA_DIR="${DATA_DIR:-/var/lib/home-library}"
DB="${DB:-$DATA_DIR/library.db}"
OWNER_FILE="${OWNER_FILE:-$DATA_DIR/OWNER}"
IMAGE="${IMAGE:-library.local/home-library:latest}"
# Timestamped hardlinks are free until the DB changes, but each one pins the old
# pages once it does. Keep a bounded window.
KEEP="${KEEP:-10}"
VIP_DEV="${VIP_DEV:-lo}"
LOCK="/run/home-library-failover.lock"

ME=$(hostname -s)
log() { echo "[failover $(date -Is)] $*" >&2; }
die() { log "FAILED: $*"; exit 1; }

# Every peer operation is one of failover-peer.sh's verbs. Nothing here builds a
# shell command for the far side, so nothing here can be turned into one.
on_peer() {
  ssh -i "$KEY" -p "$PEER_PORT" -o ConnectTimeout=10 -o BatchMode=yes \
      -o StrictHostKeyChecking=accept-new "root@$PEER" "$@"
}

# One handoff at a time. Two overlapping runs could hand the DB both ways.
exec 9>"$LOCK"
flock -n 9 || die "another failover is already running"

# ─── database movement ──────────────────────────────────────────────────────────
# Fold the WAL into the main file so a single file is a complete copy. Skipping
# this loses every committed transaction still sitting in -wal, which is the
# default state after the container is SIGTERMed.
checkpoint_local() {
  [ -f "$DB" ] || return 0
  docker run --rm -v "$DATA_DIR:/data" "$IMAGE" node -e '
    const db = require("better-sqlite3")("/data/" + process.argv[1]);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const r = db.pragma("integrity_check")[0].integrity_check;
    db.close();
    if (r !== "ok") { console.error("integrity_check: " + r); process.exit(1); }
  ' "$(basename "$DB")" >/dev/null
}
checkpoint_peer() { on_peer db-checkpoint; }

# Snapshot the destination's current DB to a timestamped hardlink before it is
# replaced, so a bad handoff is recoverable. A rename cannot disturb the link:
# it repoints the directory entry and leaves the old inode held by the link.
snapshot_local() {
  [ -f "$DB" ] || return 0
  ln -f "$DB" "$DB.$(date -u +%Y%m%dT%H%M%SZ)"
  ls -1t "$DB".*Z 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done
}
snapshot_peer() { on_peer db-snapshot; }

# Newest mtime across the database AND its WAL. Using library.db alone would be
# wrong: in WAL mode commits land in -wal and the main file's mtime can lag far
# behind the last actual write, so a busy database can look older than a stale one.
db_mtime_local() {
  { stat -c %Y "$DB" 2>/dev/null || echo 0; stat -c %Y "$DB-wal" 2>/dev/null || echo 0; } | sort -rn | head -1
}
db_mtime_peer() { on_peer db-mtime; }

# Refuse to overwrite a copy that a LATER handoff produced. This is the real
# interlock: generations only advance when ownership actually changes hands.
# Set FORCE=1 to override deliberately.
assert_generation_ok() {   # $1=src gen  $2=dst gen  $3=description
  if [ "$2" -gt "$1" ]; then
    log "REFUSING $3: destination generation $2 is newer than source generation $1"
    log "  the destination was made authoritative by a later handoff than this copy"
    [ "${FORCE:-0}" = 1 ] || die "$3 would overwrite newer data (set FORCE=1 to override)"
    log "FORCE=1 set — proceeding anyway"
  fi
}

# mtime is now a diagnostic rather than a gate. It is most useful precisely when it
# DISAGREES with the generations: that means something opened or wrote to a database
# outside a handoff, which is worth knowing about even though it must not block one.
warn_if_mtime_disagrees() {   # $1=src mtime  $2=dst mtime  $3=description
  if [ "$2" -gt "$1" ]; then
    log "note: destination mtime $2 is newer than source $1 for $3"
    log "      generations permit this, so something touched the standby outside a handoff"
  fi
}

# Stale -wal/-shm beside a replaced database is not merely untidy: SQLite may
# apply a WAL belonging to the *previous* file. Always clear them on the swap.
# Both take mtimes captured by the caller BEFORE stopping/checkpointing anything:
# a checkpoint rewrites the main file and sets its mtime to now, so measuring after
# one would make the source look newest every time and the guard would never fire.
push_db() {   # local -> peer; $1=src gen $2=dst gen $3=src mtime $4=dst mtime
  assert_generation_ok "$1" "$2" "push to $PEER_NAME"
  warn_if_mtime_disagrees "$3" "$4" "push to $PEER_NAME"
  snapshot_peer
  on_peer db-recv < "$DB"
}
pull_db() {   # peer -> local; $1=src gen $2=dst gen $3=src mtime $4=dst mtime
  assert_generation_ok "$1" "$2" "pull from $PEER_NAME"
  warn_if_mtime_disagrees "$3" "$4" "pull from $PEER_NAME"
  snapshot_local
  on_peer db-send > "$DB.incoming"
  [ -s "$DB.incoming" ] || { rm -f "$DB.incoming"; die "received an empty database from $PEER_NAME"; }
  mv -f "$DB.incoming" "$DB"
  rm -f "$DB-wal" "$DB-shm"
  chmod 644 "$DB"
}

# ─── ownership ──────────────────────────────────────────────────────────────────
# The marker is "<node> <generation>". Both nodes record the same value, so "who
# owns this?" has one answer whichever node you ask, and the generation increments
# on every handoff.
#
# The generation — not mtime — decides which copy is authoritative. mtime turned out
# to be an unreliable gate: merely OPENING a SQLite database updates it, so a standby
# started for any reason immediately looks newer than the rightful owner and would
# refuse the next legitimate handoff. A counter only moves when a handoff actually
# happens. Markers written before this change have no second field and read as 0.
owner_raw_local() { [ -f "$OWNER_FILE" ] && cat "$OWNER_FILE" || echo "none 0"; }
owner_raw_peer()  { on_peer owner-get 2>/dev/null || echo "unknown 0"; }
owner_node() { echo "$1" | awk '{ print $1 }'; }
owner_gen()  { echo "$1" | awk '{ if ($2 == "") print 0; else print $2 }'; }

set_owner() {   # $1 = owning node name
  _gl=$(owner_gen "$(owner_raw_local)")
  _gp=$(owner_gen "$(owner_raw_peer)")
  _next=$(( _gl > _gp ? _gl + 1 : _gp + 1 ))
  printf '%s %s\n' "$1" "$_next" > "$OWNER_FILE"
  on_peer owner-set "$1" "$_next" || log "warning: could not update the owner marker on $PEER_NAME"
  log "owner is now $1 (generation $_next)"
}

# ─── floating IP ────────────────────────────────────────────────────────────────
vip_up_local() {
  ip addr show dev "$VIP_DEV" | grep -q "inet $VIP/32" || ip addr add "$VIP/32" dev "$VIP_DEV"
  tailscale set --advertise-routes="$VIP/32"
}
vip_down_local() {
  tailscale set --advertise-routes=
  ip addr del "$VIP/32" dev "$VIP_DEV" 2>/dev/null || true
}
vip_up_peer()   { on_peer vip-up; }
vip_down_peer() { on_peer vip-down; }

wait_healthy() {   # $1 = "local" | "peer"
  url="http://127.0.0.1:30800/library/"
  i=0
  while [ $i -lt 30 ]; do
    if [ "$1" = local ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)
    else
      code=$(on_peer health)
    fi
    [ "$code" = 200 ] && return 0
    i=$((i + 1)); sleep 2
  done
  return 1
}

PEER_NAME=$(on_peer hostname 2>/dev/null || echo "$PEER")

case "${1:-}" in
# ─── systemd hook modes ─────────────────────────────────────────────────────────
# These exist because a hook must NEVER run `systemctl` against the local app.
# The first version of this script did, from a unit ordered After=home-library,
# and it deadlocked: systemd was waiting for our ExecStop while our ExecStop was
# waiting for systemd to run a stop job. It hung every time until the timeout.
#
# Instead systemd owns the app's lifecycle and two units bracket it:
#   home-library-db.service   Before=home-library  -> starts first, stops LAST
#   home-library-vip.service  After=home-library   -> starts last,  stops FIRST
# so at db-release the app is already stopped, and at vip-claim it is already up.

# Boot, before the app starts: put the right database in place.
db-claim)
  log "db-claim on $ME (peer $PEER_NAME)"
  raw_peer=$(owner_raw_peer); raw_local=$(owner_raw_local)
  o_peer=$(owner_node "$raw_peer"); g_peer=$(owner_gen "$raw_peer")
  g_local=$(owner_gen "$raw_local")
  m_peer=$(db_mtime_peer 2>/dev/null || echo 0); m_local=$(db_mtime_local)
  log "ownership: peer=$o_peer gen(peer)=$g_peer gen(local)=$g_local | mtimes: local=$m_local peer=$m_peer"
  vip_down_local; vip_down_peer || true
  on_peer svc-stop || log "warning: could not stop the app on $PEER_NAME"
  if [ "$o_peer" = "$PEER_NAME" ]; then
    checkpoint_peer && pull_db "$g_peer" "$g_local" "$m_peer" "$m_local"
    log "pulled the database from $PEER_NAME"
  else
    log "peer does not own the database (owner=$o_peer); KEEPING the local copy"
    checkpoint_local; snapshot_local
  fi
  set_owner "$ME"
  ;;

# Boot, after the app started: claim the floating address once it answers.
vip-claim)
  wait_healthy local || die "app did not become healthy; leaving the VIP unassigned"
  vip_up_local
  log "active on $ME at http://$VIP/library/"
  ;;

# Shutdown, before the app stops: stop advertising immediately.
vip-release)
  vip_down_local
  log "released the VIP on $ME"
  ;;

# Shutdown, after the app has already stopped: hand the database to the peer.
db-release)
  log "db-release: handing over from $ME to $PEER_NAME"
  g_local=$(owner_gen "$(owner_raw_local)"); g_peer=$(owner_gen "$(owner_raw_peer)")
  m_local=$(db_mtime_local); m_peer=$(db_mtime_peer 2>/dev/null || echo 0)
  log "generations: local=$g_local peer=$g_peer | mtimes: local=$m_local peer=$m_peer"
  vip_down_local; vip_down_peer || true
  checkpoint_local
  push_db "$g_local" "$g_peer" "$m_local" "$m_peer"
  set_owner "$PEER_NAME"
  on_peer svc-start
  wait_healthy peer || die "peer did not come up; VIP left unassigned, DB is on both"
  vip_up_peer
  log "active on $PEER_NAME"
  ;;

# ─── manual commands ────────────────────────────────────────────────────────────
# Safe to use `systemctl` here: run by hand, not from inside a systemd job.
to-local)
  log "manual takeover on $ME"
  "$0" db-claim
  systemctl start "$SERVICE"
  "$0" vip-claim
  ;;

to-remote)
  log "manual handover from $ME to $PEER_NAME"
  "$0" vip-release
  systemctl stop "$SERVICE" || true
  systemctl reset-failed "$SERVICE" 2>/dev/null || true
  "$0" db-release
  ;;

status)
  echo "this node:  $ME"
  echo "peer:       $PEER_NAME"
  echo "owner here: $(owner_raw_local)"
  echo "owner peer: $(owner_raw_peer)"
  echo "app here:   $(systemctl is-active "$SERVICE" 2>/dev/null)"
  echo "VIP $VIP here: $(ip addr show dev "$VIP_DEV" | grep -q "inet $VIP/32" && echo assigned || echo no)"
  ;;

*) echo "usage: $0 {to-local|to-remote|status|db-claim|db-release|vip-claim|vip-release}" >&2; exit 2 ;;
esac
