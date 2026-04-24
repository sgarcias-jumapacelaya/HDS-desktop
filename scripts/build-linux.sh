#!/usr/bin/env bash
# Build HDS Desktop para Linux (.deb y .AppImage) usando Docker.
# Output → ./dist-bundles/
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="$(pwd)/dist-bundles"
mkdir -p "$OUT_DIR"

IMG=hds-desktop-build:latest

echo ">> Building docker image $IMG"
docker build -f Dockerfile.build -t "$IMG" .

echo ">> Extracting artifacts to $OUT_DIR"
CID=$(docker create "$IMG")
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

docker cp "$CID":/out/deb "$OUT_DIR/" 2>/dev/null || true
docker cp "$CID":/out/appimage "$OUT_DIR/" 2>/dev/null || true

echo
echo ">> Artefactos generados:"
find "$OUT_DIR" -maxdepth 3 -type f \( -name "*.deb" -o -name "*.AppImage" \) -printf "%p  (%s bytes)\n"
