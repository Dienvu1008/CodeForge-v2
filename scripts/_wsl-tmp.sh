#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/node20/bin:$PATH"
SRC="/mnt/c/Users/Dienv/Desktop/My Projects/VS Code Extensions/CodeForge v2"
DEST="$HOME/cf2"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude '.git' \
  --exclude '_*.log' --exclude '_*.txt' --exclude 'scripts/_wsl-tmp.sh' \
  --exclude '*.tsbuildinfo' \
  "$SRC/" "$DEST/"
cd "$DEST"
echo "=== node ==="; node --version
echo "=== npm ci ==="; npm ci --no-audit --no-fund >/tmp/cf2install.log 2>&1 || { tail -40 /tmp/cf2install.log; exit 1; }
echo "=== build ==="; npm run build 2>&1 | tail -5
echo "=== typecheck ==="; npm run typecheck 2>&1 | tail -3
echo "=== code-intelligence tests (WASM on Linux) ==="; node node_modules/vitest/vitest.mjs run tests/code-intelligence 2>&1 | tail -8
echo "=== full test ==="; node node_modules/vitest/vitest.mjs run 2>&1 | tail -6
echo "=== lint ==="; npm run lint 2>&1 | tail -3
echo "=== depcruise ==="; npm run depcruise 2>&1 | tail -3
echo "=== DONE ==="