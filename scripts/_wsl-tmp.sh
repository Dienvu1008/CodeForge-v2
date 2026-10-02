#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/node20/bin:$PATH"
SRC="/mnt/c/Users/Dienv/Desktop/My Projects/VS Code Extensions/CodeForge v2"
DEST="$HOME/cf2"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude '.git' \
  --exclude '_*.log' --exclude 'scripts/_wsl-tmp.sh' \
  --exclude '*.tsbuildinfo' \
  "$SRC/" "$DEST/"
cd "$DEST"
echo "=== node ==="; node --version
echo "=== npm install ==="; npm install --no-audit --no-fund >/tmp/cf2install.log 2>&1 || { tail -30 /tmp/cf2install.log; exit 1; }
echo "=== build ==="; npm run build 2>&1 | tail -5
echo "=== typecheck ==="; npm run typecheck 2>&1 | tail -3
echo "=== test ==="; node node_modules/vitest/vitest.mjs run 2>&1 | tail -8
echo "=== DONE ==="
