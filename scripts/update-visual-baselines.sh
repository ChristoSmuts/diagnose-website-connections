#!/usr/bin/env bash
#
# Regenerate the visual baselines locally, in the same container CI compares against.
#
# Font rasterisation differs between Windows, macOS and Linux, so a baseline taken
# on a developer machine can never match CI. That is why the committed baselines
# are Linux-only — but "Linux-only" does not have to mean "GitHub-only". Running
# the official Playwright image pins the browsers and the fonts to exactly what the
# `e2e` job uses, so the images this produces are the images CI expects.
#
#   ./scripts/update-visual-baselines.sh
#
# Needs Docker and nothing else; the repo's own toolchain is installed inside the
# container. On Windows, run it from WSL, where Docker lives.
#
# The source tree is copied into the container rather than bind-mounted, because a
# bind mount would put a Linux `pnpm install` on top of the Windows `node_modules`
# and leave the host unable to build. Only the generated PNGs come back.

set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="e2e/specs/visual.spec.ts-snapshots"

if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
  echo "==> Pulling $IMAGE (about 2 GB, once)"
  docker pull "$IMAGE"
fi

mkdir -p "$REPO_ROOT/$SNAPSHOT_DIR"

echo "==> Regenerating baselines in $IMAGE"

# `|| true` on the test run is deliberate and not laziness: Playwright exits
# non-zero whenever it *writes* a snapshot, which is the correct behaviour for a
# normal run and exactly what this script is asking it to do.
docker run --rm \
  -v "$REPO_ROOT":/src:ro \
  -v "$REPO_ROOT/$SNAPSHOT_DIR":/out \
  -w /work \
  "$IMAGE" \
  bash -euo pipefail -c '
    # Copy in without node_modules, dist or .git: the host tree is built for
    # Windows and none of it is usable here.
    mkdir -p /work
    tar -C /src \
      --exclude=node_modules --exclude=.git --exclude=dist \
      --exclude=playwright-report --exclude=test-results --exclude=data \
      -cf - . | tar -C /work -xf -

    corepack enable
    pnpm install --frozen-lockfile
    pnpm run build

    pnpm --filter @dwc/e2e exec playwright test specs/visual.spec.ts --update-snapshots || true

    # Hand the images back. Nothing else leaves the container.
    cp -v /work/'"$SNAPSHOT_DIR"'/*.png /out/
  '

echo
echo "==> Done. Review and commit:"
git -C "$REPO_ROOT" status --short -- "$SNAPSHOT_DIR"
