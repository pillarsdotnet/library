#!/bin/sh
# Compare the CPU cost of Docker images under the same work -- for instance
# two releases, or the image with and without its allocator tuned.
# bench/memory.mjs is its memory counterpart.
#
# Usage: SEED_DB=<library.db> bench/cpu.sh <config> [<config> ...]
#   where a config is an image, optionally with container environment:
#   ghcr.io/pillarsdotnet/library:5.4.0,MALLOC_ARENA_MAX=2
#   ROUNDS=5, SERVER_CPUS=2,4, CLIENT_CPUS=8,10,12, OUT=bench-cpu.jsonl
#   Then: node bench/cpu-report.mjs bench-cpu.jsonl
#
# Each round runs every config, in an order rotated from the round before, so
# drift in the machine (heat, turbo, a neighbour) lands on all of them alike:
#   micro  - bench/cpu-micro.mjs inside the image: SQLite, JSON, sharp, crypto,
#            compression, the app's own sort, and two controls
#   http   - the app itself on a fresh copy of SEED_DB, sign-in off, loaded for
#            10 s per endpoint by bench/cpu-http.mjs, with the server's CPU time
#            read from its cgroup, so the result is CPU per request as well as
#            requests per second
#
# Pin SERVER_CPUS and CLIENT_CPUS to separate physical cores of one kind: on a
# hybrid CPU, a run that lands on an efficiency core measures the core, not the
# image. Needs docker, and sqlite3 to take a consistent copy of SEED_DB.
set -eu

[ $# -gt 0 ] || { echo "usage: SEED_DB=<library.db> $0 <image[,KEY=VALUE...]>..." >&2; exit 1; }
[ -n "${SEED_DB:-}" ] && [ -f "$SEED_DB" ] || { echo "SEED_DB must name a library database" >&2; exit 1; }
BENCH=$(cd "$(dirname "$0")" && pwd)
ROUNDS=${ROUNDS:-5}
SERVER_CPUS=${SERVER_CPUS:-2,4}
CLIENT_CPUS=${CLIENT_CPUS:-8,10,12}
PORT=${PORT:-38080}
OUT=${OUT:-bench-cpu.jsonl}
WORK=$(mktemp -d)
ENDPOINTS="/api/books /api/meta /api/genres /healthz /"
CLIENT_IMAGE=${1%%,*}
log() { echo "[$(date +%T)] $*" >&2; }
cleanup() { docker rm -f cpubench-srv >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

image_of() { echo "${1%%,*}"; }
# "-e KEY=VALUE" for each setting after the image.
env_of() {
  case $1 in *,*) ;; *) return 0 ;; esac
  echo "${1#*,}" | tr ',' '\n' | while read -r kv; do printf ' -e %s' "$kv"; done
}
json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

cgroup_stat() {
  for f in "/sys/fs/cgroup/system.slice/docker-$1.scope/cpu.stat" "/sys/fs/cgroup/docker/$1/cpu.stat"; do
    [ -f "$f" ] && { echo "$f"; return; }
  done
  echo "no cgroup v2 cpu.stat for container $1" >&2; exit 1
}
usage() { awk '/^usage_usec/{print $2}' "$1"; }

if command -v sqlite3 >/dev/null; then sqlite3 "$SEED_DB" ".backup $WORK/seed.db"; else cp "$SEED_DB" "$WORK/seed.db"; fi
fresh() { rm -rf "$WORK/run"; mkdir -p "$WORK/run"; cp "$WORK/seed.db" "$WORK/run/library.db"; }

: > "$OUT"
for cfg in "$@"; do
  echo "{\"kind\":\"image\",\"config\":\"$(json "$cfg")\",\"id\":\"$(docker image inspect -f '{{.Id}}' "$(image_of "$cfg")")\"}" >> "$OUT"
done

micro() {  # config round
  fresh
  # shellcheck disable=SC2046  # env_of is meant to split into words
  res=$(docker run --rm --network none --cpuset-cpus "$SERVER_CPUS" $(env_of "$1") \
          -v "$BENCH:/bench:ro" -v "$WORK/run:/data" -e BENCH_DB=/data/library.db \
          -w /app "$(image_of "$1")" node /bench/cpu-micro.mjs)
  echo "{\"kind\":\"micro\",\"config\":\"$(json "$1")\",\"round\":$2,\"data\":$res}" >> "$OUT"
}

http() {  # config round
  fresh
  t0=$(date +%s%N)
  # shellcheck disable=SC2046
  id=$(docker run -d --name cpubench-srv --cpuset-cpus "$SERVER_CPUS" $(env_of "$1") \
         -p "127.0.0.1:$PORT:3000" -v "$WORK/run:/data" -e DB_PATH=/data/library.db \
         -e TZ="${TZ:-UTC}" "$(image_of "$1")")
  until curl -sf -o /dev/null "http://127.0.0.1:$PORT/healthz"; do sleep 0.02; done
  start_ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  stat=$(cgroup_stat "$id")
  echo "{\"kind\":\"startup\",\"config\":\"$(json "$1")\",\"round\":$2,\"ms\":$start_ms,\"cpu_us\":$(usage "$stat")}" >> "$OUT"
  # Warm-up, not recorded: the JIT and SQLite's page cache.
  docker run --rm --network host --cpuset-cpus "$CLIENT_CPUS" -v "$BENCH:/bench:ro" -e SECONDS=3 \
    "$CLIENT_IMAGE" node /bench/cpu-http.mjs "http://127.0.0.1:$PORT" /api/books >/dev/null
  for ep in $ENDPOINTS; do
    u0=$(usage "$stat")
    res=$(docker run --rm --network host --cpuset-cpus "$CLIENT_CPUS" -v "$BENCH:/bench:ro" \
            -e SECONDS=10 -e CONC=8 "$CLIENT_IMAGE" node /bench/cpu-http.mjs "http://127.0.0.1:$PORT" "$ep")
    u1=$(usage "$stat")
    echo "{\"kind\":\"http\",\"config\":\"$(json "$1")\",\"round\":$2,\"server_cpu_us\":$((u1 - u0)),\"data\":$res}" >> "$OUT"
  done
  docker rm -f cpubench-srv >/dev/null
}

CONFIGS="$*"   # a config never contains a space, so the list survives this
round=1
while [ "$round" -le "$ROUNDS" ]; do
  # Round n starts with config n, wrapping round.
  # shellcheck disable=SC2086
  set -- $CONFIGS
  i=1; while [ $i -le $(( (round - 1) % $# )) ]; do set -- "$@" "$1"; shift; i=$((i + 1)); done
  log "round $round/$ROUNDS; load $(cut -d' ' -f1-3 /proc/loadavg)"
  for cfg in "$@"; do
    log "  $cfg: micro"; micro "$cfg" "$round"
    log "  $cfg: http";  http "$cfg" "$round"
  done
  round=$((round + 1))
done
log "done: $OUT"
