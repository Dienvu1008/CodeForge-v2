#!/usr/bin/env bash
# Install a local Node 20 LTS in WSL ($HOME/node20) without sudo, for cross-platform
# verification of the workspace-hash vectors. Idempotent.
set -euo pipefail

NODE_VERSION="v20.18.1"
ARCH="linux-x64"
DEST="$HOME/node20"
TARBALL="node-${NODE_VERSION}-${ARCH}.tar.xz"
URL="https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"

echo "== wsl-setup-node =="
if [ -x "$DEST/bin/node" ]; then
  echo "already installed:"
  "$DEST/bin/node" -v
  exit 0
fi

mkdir -p "$DEST"
cd "$HOME"
echo "downloading $URL"
curl -fsSL "$URL" -o "$TARBALL"
echo "extracting"
tar -xf "$TARBALL" -C "$DEST" --strip-components=1
rm -f "$TARBALL"
echo "installed:"
"$DEST/bin/node" -v
"$DEST/bin/npm" -v
echo "DONE"
