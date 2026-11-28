#!/usr/bin/env bash
# Deploy the committed code to a Linux server over SSH (one connection, one password prompt).
# Usage: bash scripts/deploy.sh root@178.16.138.221 [public_url]
# Example: bash scripts/deploy.sh root@178.16.138.221 http://178.16.138.221:3000
set -euo pipefail
TARGET="${1:?usage: deploy.sh user@host [public_url]}"
PUBLIC_URL="${2:-}"
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env missing"; exit 1; }
if [ -n "$(git status --porcelain -- server public package.json package-lock.json)" ]; then
  echo "Commit your changes first (deploy ships the committed code)."; exit 1
fi
STAMP=$(date +%Y%m%d%H%M%S)
TMP=$(mktemp -d)
git archive --format=tar HEAD -o "$TMP/bundle.tar"
tar --append -f "$TMP/bundle.tar" .env
echo "Deploying $(git rev-parse --short HEAD) to $TARGET ..."
ssh -o StrictHostKeyChecking=accept-new "$TARGET" \
  "set -e; S=/tmp/geogrowth-$STAMP; rm -rf \$S; mkdir -p \$S; tar -x -C \$S; bash \$S/scripts/remote-setup.sh \$S '$PUBLIC_URL'" < "$TMP/bundle.tar"
rm -rf "$TMP"
