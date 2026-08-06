#!/usr/bin/env bash
# Fetch the DeepFilterNet3 `deep-filter` binary into backend/bin/.
#
# We use the upstream prebuilt binary rather than `pip install deepfilternet`
# because the Python package pins numpy<2, needs a Rust toolchain to build its
# native half on Python 3.12, and imports a torchaudio API removed in 2.x — see
# the module docstring in denoise.py. The binary is the same DeepFilterNet3
# model with the weights baked in and no dependencies.
set -euo pipefail

VERSION="${DEEPFILTER_VERSION:-0.5.6}"
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin"
DEST="$BIN_DIR/deep-filter"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)   ASSET="deep-filter-${VERSION}-x86_64-unknown-linux-musl" ;;
  Linux/aarch64)  ASSET="deep-filter-${VERSION}-aarch64-unknown-linux-gnu" ;;
  Darwin/arm64)   ASSET="deep-filter-${VERSION}-aarch64-apple-darwin" ;;
  Darwin/x86_64)  ASSET="deep-filter-${VERSION}-x86_64-apple-darwin" ;;
  *)
    echo "No prebuilt deep-filter for $(uname -s)/$(uname -m)." >&2
    echo "Grab one from https://github.com/Rikorose/DeepFilterNet/releases and" >&2
    echo "point DEEPFILTER_BIN at it, or run with DEEPFILTER=0." >&2
    exit 1
    ;;
esac

URL="https://github.com/Rikorose/DeepFilterNet/releases/download/v${VERSION}/${ASSET}"

mkdir -p "$BIN_DIR"
echo "Downloading $ASSET …"
curl -fSL --progress-bar -o "$DEST.tmp" "$URL"
chmod +x "$DEST.tmp"
mv "$DEST.tmp" "$DEST"

"$DEST" --version
echo "Installed $DEST"
