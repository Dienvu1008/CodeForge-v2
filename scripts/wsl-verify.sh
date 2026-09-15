#!/usr/bin/env bash
# Cross-platform verification in WSL2 (ext4, case-sensitive).
#
# Copies the repo into the WSL native filesystem (~/cf2) so v016 (case collision),
# v019 (permissions), v020 (tab-in-name) can be created for real, then:
#   1. npm ci + typecheck
#   2. run workspace + cross-platform tests (assert Linux hash == committed expected)
#   3. run the generator to produce expected.json for the linux-only vectors
#
# Prints a clear PASS/FAIL summary. Requires $HOME/node20 from wsl-setup-node.sh.
set -uo pipefail

export PATH="$HOME/node20/bin:$PATH"
SRC="/mnt/c/Users/Dienv/Desktop/My Projects/VS Code Extensions/CodeForge v2"
DEST="$HOME/cf2"

echo "== node/npm =="
node -v
npm -v

echo "== sync repo to ext4 ($DEST) =="
mkdir -p "$DEST"
# rsync if available, else cp; exclude heavy/generated dirs
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'node_modules' --exclude '**/dist' --exclude '.git' \
    --exclude '_*.txt' --exclude '_*.log' \
    "$SRC/" "$DEST/"
else
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -r "$SRC/." "$DEST/"
  rm -rf "$DEST/node_modules"
  find "$DEST" -type d -name dist -prune -exec rm -rf {} + 2>/dev/null || true
fi

cd "$DEST"
echo "== npm ci =="
npm ci --no-audit --no-fund

echo "== typecheck =="
npm run typecheck

echo "== workspace-vectors + cross-platform tests =="
npx vitest run tests/workspace tests/cross-platform tests/invariants/workspace
TEST_RC=$?

echo "== generate linux expected (v016/v019/v020 etc) =="
node scripts/gen-vector-expected.mjs > _genlinux.txt 2>&1
cat _genlinux.txt

echo "== copy generated expected back to source (linux-only vectors) =="
for v in v016-case-collision v019-permissions v020-special-chars; do
  if [ -f "$DEST/tests/workspace/vectors/$v/expected.json" ]; then
    mkdir -p "$SRC/tests/workspace/vectors/$v"
    cp "$DEST/tests/workspace/vectors/$v/expected.json" "$SRC/tests/workspace/vectors/$v/expected.json"
    echo "copied $v"
  fi
done

echo "== SUMMARY =="
if [ "$TEST_RC" -eq 0 ]; then
  echo "CROSS_PLATFORM_TESTS: PASS"
else
  echo "CROSS_PLATFORM_TESTS: FAIL (rc=$TEST_RC)"
fi
echo "DONE"
