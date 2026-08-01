#!/bin/sh
# Hand the live Home Library between two nodes, moving the SQLite database with
# it so exactly one node is ever writable.
#
#   failover.sh status      show who owns the app
#   failover.sh to-local    take over here   (manual)
#   failover.sh to-remote   hand to the peer (manual)
#
# At boot and shutdown systemd drives the four hook modes instead — db-claim,
# vip-claim, vip-release, db-release — via home-library-db.service and
# home-library-vip.service. Never invoke the hook modes by hand while those units
# are enabled; use to-local / to-remote, which sequence them safely.
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
#   1. An autoApprovers entry for the route in the tailnet policy file. Approving
#      by hand is not enough: approval is per-node, so the standby's advertisement
#      is unapproved and the address points nowhere until someone notices.
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
COVERS_DIR="${COVERS_DIR:-$DATA_DIR/covers}"
OWNER_FILE="${OWNER_FILE:-$DATA_DIR/OWNER}"
IMAGE="${IMAGE:-library.local/home-library:latest}"
# How many timestamped snapshots to keep. They are real copies now, so the window
# costs KEEP × the database — which since covers moved out to files is a few
# hundred kilobytes each, not the twelve megabytes it used to be.
KEEP="${KEEP:-10}"
VIP_DEV="${VIP_DEV:-lo}"
LOCK="/run/home-library-failover.lock"

# Which node reclaims the service when it boots. Both nodes run identical units, so
# something has to break the tie: without it a standby that reboots would pull the
# database from a perfectly healthy preferred node and take over.
PREFERRED="${PREFERRED:-homelab}"

# "This node should be running the app." Lives in /run, so a reboot clears it and
# db-claim has to decide afresh every boot. The app and vip units test it with
# ConditionPathExists, which makes systemd SKIP them rather than fail them — a
# standby boot is a normal outcome, not an error.
ACTIVE_FLAG="${ACTIVE_FLAG:-/run/home-library-active}"
mark_active()   { : > "$ACTIVE_FLAG"; }
mark_standby()  { rm -f "$ACTIVE_FLAG"; }

ME=$(hostname -s)
log() { echo "[failover $(date -Is)] $*" >&2; }
die() { log "FAILED: $*"; exit 1; }

# Every peer operation is one of failover-peer.sh's verbs. Nothing here builds a
# shell command for the far side, so nothing here can be turned into one.
on_peer() {
  ssh -i "$KEY" -p "$PEER_PORT" -o ConnectTimeout=10 -o BatchMode=yes \
      -o StrictHostKeyChecking=accept-new "root@$PEER" "$@"
}

# Is the peer reachable? Retried, because at boot the mesh VPN daemon can be
# "active" while the tailnet is not yet connected — observed 8s after tailscaled
# started and still failing — so a single attempt misreports a healthy peer as gone.
peer_reachable() {
  _i=0
  while [ $_i -lt 10 ]; do
    if on_peer hostname >/dev/null 2>&1; then return 0; fi
    _i=$((_i + 1)); sleep 3
  done
  return 1
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

# Snapshot the destination's current DB to a timestamped COPY before it is
# replaced, so a bad handoff is recoverable.
#
# This used to be `ln -f`, which is not a snapshot at all: a hardlink is another
# NAME for the same inode, and SQLite writes in place, so every "snapshot" changed
# in lockstep with the live database. The whole rotation looked like a set of
# restore points and was in fact one file under ten names. (The old comment
# reasoned about rename repointing the directory entry — true, and irrelevant,
# because the destructive path here is a write, not a rename.)
#
# `.backup` rather than `cp`: it is consistent against a database that something
# still has open, which `cp` is not. Real copies cost real disk — ten generations
# of a 12 MB database is 120 MB — which is the price of them existing at all.
snapshot_local() {
  [ -f "$DB" ] || return 0
  command -v sqlite3 >/dev/null || die "sqlite3 is required to snapshot the database"
  sqlite3 "$DB" ".backup '$DB.$(date -u +%Y%m%dT%H%M%SZ)'"
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
# Cover images are files beside the database and the two are worthless apart, so
# every movement of one moves the other. Sent as a tar stream through a verb, for
# the same reason the database is: the peer names the directory, the caller cannot.
push_covers() {
  [ -d "$COVERS_DIR" ] || return 0
  tar -C "$DATA_DIR" -cf - "$(basename "$COVERS_DIR")" | on_peer covers-recv
}
pull_covers() {
  staging="$DATA_DIR/.covers.incoming"
  rm -rf "$staging"; mkdir -p "$staging"
  if on_peer covers-send | tar -C "$staging" --no-absolute-names --no-same-owner -xf - \
     && [ -d "$staging/covers" ]; then
    find "$staging" -type l -delete
    rm -rf "$COVERS_DIR.old"
    if [ -d "$COVERS_DIR" ]; then mv "$COVERS_DIR" "$COVERS_DIR.old"; fi
    mv "$staging/covers" "$COVERS_DIR"
    rm -rf "$COVERS_DIR.old"
  else
    # A peer with no covers yet is normal; it must not fail the handoff, and the
    # local set is left exactly as it was rather than being emptied on a guess.
    log "no covers received from $PEER_NAME — keeping the local set"
  fi
  rm -rf "$staging"
}

push_db() {   # local -> peer; $1=src gen $2=dst gen $3=src mtime $4=dst mtime
  assert_generation_ok "$1" "$2" "push to $PEER_NAME"
  warn_if_mtime_disagrees "$3" "$4" "push to $PEER_NAME"
  snapshot_peer
  on_peer db-recv < "$DB"
  push_covers
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
  pull_covers
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
  raw_local=$(owner_raw_local)
  o_local=$(owner_node "$raw_local")

  # A standby that reboots must leave a healthy active node completely alone: no
  # VIP change, no stopping its app, no pulling its database. Only the preferred
  # node reclaims on boot; a non-preferred node comes up active only if it already
  # owns the database, i.e. the preferred node handed over and has not come back.
  if [ "$ME" != "$PREFERRED" ] && [ "$o_local" != "$ME" ]; then
    log "standby boot: $o_local owns the database and $ME is not the preferred node"
    log "staying standby — the app and VIP units will be skipped"
    mark_standby
    exit 0
  fi

  vip_down_local

  if ! peer_reachable; then
    # Degraded path. The peer's marker is the only thing that can tell us whether it
    # took over, so with the peer unreachable we must not guess.
    log "WARNING: $PEER_NAME is unreachable"
    case "$o_local" in
      "$ME"|none)
        # Our own marker says we hold it, so serving the local copy is correct.
        # Deliberately do NOT bump the generation: we could not compare against the
        # peer, and raising ours above a copy we never saw would defeat the guard and
        # let a later push overwrite newer data.
        log "local marker says $o_local owns it; keeping the local copy, generation unchanged"
        checkpoint_local; snapshot_local
        ;;
      *)
        # The peer owns it and we cannot reach it. Serving our stale copy would
        # present it as authoritative and set up a silent overwrite later.
        die "the database is owned by $o_local, which is unreachable; refusing to serve a stale copy"
        ;;
    esac
  else
    raw_peer=$(owner_raw_peer)
    o_peer=$(owner_node "$raw_peer"); g_peer=$(owner_gen "$raw_peer")
    g_local=$(owner_gen "$raw_local")
    m_peer=$(db_mtime_peer 2>/dev/null || echo 0); m_local=$(db_mtime_local)
    log "ownership: peer=$o_peer gen(peer)=$g_peer gen(local)=$g_local | mtimes: local=$m_local peer=$m_peer"
    vip_down_peer || true
    on_peer svc-stop || log "warning: could not stop the app on $PEER_NAME"
    if [ "$o_peer" = "$PEER_NAME" ]; then
      checkpoint_peer && pull_db "$g_peer" "$g_local" "$m_peer" "$m_local"
      log "pulled the database from $PEER_NAME"
    else
      log "peer does not own the database (owner=$o_peer); KEEPING the local copy"
      checkpoint_local; snapshot_local
    fi
    set_owner "$ME"
  fi
  mark_active
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
  # Hand over by starting the peer's OWN units rather than poking its app and address
  # directly. Doing the latter left the peer's db and vip units inactive, so its
  # systemd state did not reflect that it was active and its next shutdown ran no
  # ExecStop — it handed nothing back. The peer's db-claim will see it already owns
  # the database, keep its copy, and claim the address through its own vip unit.
  on_peer takeover || die "$PEER_NAME failed to take over; DB is on both, VIP unassigned"
  wait_healthy peer || die "peer did not come up; VIP left unassigned, DB is on both"
  mark_standby
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
