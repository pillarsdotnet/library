#!/bin/sh
# Deploy the current build to the homelab node and restart it.
#
# There is no image registry, so the image travels over ssh. The version tag and
# :latest are built together; the systemd unit runs :latest, so a release never
# needs the unit edited. After the restart, old home-library images are pruned
# from the node — rollback is `git checkout v<x.y.z>` and a rebuild, so stale
# images are just disk. Every deploy leaves only what is running.
#
# Usage:  deploy/deploy.sh            (deploys to host "homelab")
#         HOST=myhost deploy/deploy.sh
set -eu

HOST="${HOST:-homelab}"
IMAGE=library.local/home-library
ROOT=$(cd "$(dirname "$0")/.." && pwd)
V=$(node -p "require('$ROOT/package.json').version")

echo "→ building $IMAGE:$V (+ :latest)"
docker build -t "$IMAGE:$V" -t "$IMAGE:latest" "$ROOT"

echo "→ shipping the image to $HOST"
docker save "$IMAGE:$V" "$IMAGE:latest" | ssh "$HOST" 'sudo docker load'

echo "→ restarting on $HOST"
ssh "$HOST" 'sudo systemctl restart home-library'

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
