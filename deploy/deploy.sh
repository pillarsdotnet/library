#!/bin/sh
# Deploy the current build to the homelab node and restart it.
#
# There is no image registry, so the image travels over ssh. The version tag and
# :latest are built together; the systemd unit runs :latest, so a release never
# needs the unit edited. After the restart, old home-library images are pruned
# from the node — rollback is `git checkout v<x.y.z>` and a rebuild, so stale
# images are just disk. Every deploy leaves only what is running.
#
# The restart is gated on a health check: nothing is pruned and no success is
# reported until the app actually answers over HTTP. See the check below for why
# the restart's own exit status is not evidence of anything.
#
# Usage:  deploy/deploy.sh            (deploys to host "homelab")
#         HOST=myhost deploy/deploy.sh
#         HEALTH_TIMEOUT=120 deploy/deploy.sh
set -eu

HOST="${HOST:-homelab}"
IMAGE=library.local/home-library
ROOT=$(cd "$(dirname "$0")/.." && pwd)
V=$(node -p "require('$ROOT/package.json').version")
# Loopback-only publish port + BASE_PATH from the systemd unit, so the check has
# to run on the node itself.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:30800/library/}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

echo "→ building $IMAGE:$V (+ :latest)"
docker build -t "$IMAGE:$V" -t "$IMAGE:latest" "$ROOT"

echo "→ shipping the image to $HOST"
docker save "$IMAGE:$V" "$IMAGE:latest" | ssh "$HOST" 'sudo docker load'

echo "→ restarting on $HOST"
ssh "$HOST" 'sudo systemctl restart home-library'

# `systemctl restart` only reports that `docker run` was spawned, and the unit's
# Restart=always cheerfully respawns a container that dies immediately — so a
# clean restart exit status is compatible with a total outage. Gate the deploy on
# the app answering, and on the running container really being the image just
# built (a restart that quietly kept older code is the same bug, one step later).
#
# The whole poll runs in a single ssh session on purpose: the port is
# loopback-only on the node, and every extra connection can cost a 1Password tap.
WANT_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE:latest")

echo "→ health-checking $HEALTH_URL (up to ${HEALTH_TIMEOUT}s)"
if ! ssh "$HOST" 'sudo sh -s' <<EOF
set -eu
deadline=\$(( \$(date +%s) + $HEALTH_TIMEOUT ))
while :; do
  # curl already prints 000 when it cannot connect, so just swallow its status.
  code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 '$HEALTH_URL' || true)
  [ "\$code" = 200 ] && break
  if [ \$(date +%s) -ge \$deadline ]; then
    echo "no HTTP 200 within ${HEALTH_TIMEOUT}s; last status \$code" >&2
    exit 1
  fi
  sleep 2
done

got=\$(docker inspect -f '{{.Image}}' home-library)
if [ "\$got" != "$WANT_ID" ]; then
  echo "running container is image \$got, expected $WANT_ID" >&2
  exit 1
fi
EOF
then
  echo "✗ health check FAILED — keeping every image on $HOST so you can roll back." >&2
  echo "--- systemctl status home-library ---" >&2
  ssh "$HOST" 'sudo systemctl status home-library --no-pager 2>&1 | head -20' >&2 || true
  echo "--- docker logs home-library (last 40) ---" >&2
  ssh "$HOST" 'sudo docker logs --tail 40 home-library 2>&1' >&2 || true
  exit 1
fi
echo "  ✓ HTTP 200, and the running container is the image just built"

echo "→ pruning old images on $HOST (keeping :$V and :latest)"
# Remove every home-library image tag except the one just deployed and :latest,
# then drop any now-dangling layers. The running container holds a reference to
# its image, so this can never remove what is in use.
ssh "$HOST" "sudo sh -c '
  for ref in \$(docker images --format \"{{.Repository}}:{{.Tag}}\" $IMAGE | grep -v -e \":$V\$\" -e \":latest\$\"); do
    docker rmi \"\$ref\" || true
  done
  docker image prune -f >/dev/null
'"

echo "→ deployed $V; images now on $HOST:"
ssh "$HOST" "sudo docker images $IMAGE --format '   {{.Tag}}\t{{.ID}}'"
