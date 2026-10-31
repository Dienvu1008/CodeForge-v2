#!/usr/bin/env node
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// pre-push-gate.mjs — the mechanical gate run before every `git push` (and on demand via
// `npm run gate`). It exists because "remember to run the checks / sync the docs" does not
// survive across work sessions; a hook does.
//
// Steps (fail-fast, in order):
//   1. Docs-sync check: if the pushed commits change code (packages/*/src, scripts/, benchmarks/)
//      but no project .md doc, the push is rejected unless a commit message carries the trailer
//      `Docs-Reviewed: <reason>` (an explicit, auditable "no doc change needed").
//   2. build      — tsc --build (type-checks every package)
//   3. lint       — eslint .
//   4. depcruise  — dependency direction + cycle rules (architecture boundaries)
//   5. invariants — vitest run tests/invariants (kernel invariants)
//   6. full suite — vitest run, only when CF_GATE_FULL=1 (the authoritative full run is WSL
//      scripts/_wsl-tmp.sh, ~200 s, which the agent runs before committing).
//
// Tools are invoked via process.execPath + their JS entry points, so the gate works without
// npm/npx on PATH (Git Bash hooks on Windows often lack them).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ZERO = /^0+$/;
const CODE = /^(packages\/[^/]+\/src\/|scripts\/|benchmarks\/)/;
const isProjectDoc = (f) => f.endsWith('.md') && !f.startsWith('.kiro/') && !f.startsWith('.agents/');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function tryGit(args) {
  try { return git(args); } catch { return ''; }
}

// ── 1. Which commits are being pushed? ────────────────────────────────────────
function pushedRanges() {
  // git invokes pre-push as `pre-push <remote> <url>` with the refs on stdin. Without those
  // args this is an on-demand run (`npm run gate`) and stdin must not be read (it may never close).
  let stdin = '';
  if (process.argv.length > 2) {
    try { stdin = readFileSync(0, 'utf8'); } catch { stdin = ''; }
  }
  const ranges = [];
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // branch deletion
    const base = remoteSha && !ZERO.test(remoteSha)
      ? remoteSha
      : tryGit(['merge-base', localSha, 'origin/main']);
    if (base) ranges.push(`${base}..${localSha}`);
  }
  // Manual run (`npm run gate`): everything not yet on origin/main, plus the working tree.
  if (ranges.length === 0) return { ranges: ['origin/main..HEAD'], manual: true };
  return { ranges, manual: false };
}

function docsCheck() {
  const { ranges, manual } = pushedRanges();
  const files = new Set();
  let messages = '';
  for (const r of ranges) {
    for (const f of tryGit(['diff', '--name-only', r]).split('\n')) if (f) files.add(f);
    messages += tryGit(['log', '--format=%B', r]) + '\n';
  }
  if (manual) {
    // On-demand run: also consider uncommitted changes.
    for (const f of tryGit(['diff', '--name-only', 'HEAD']).split('\n')) if (f) files.add(f);
  }
  const code = [...files].filter((f) => CODE.test(f));
  const docs = [...files].filter(isProjectDoc);
  if (code.length === 0 || docs.length > 0) {
    console.log(`[gate] docs-sync: ok (${code.length} code file(s), ${docs.length} doc file(s))`);
    return true;
  }
  if (/^Docs-Reviewed:\s*\S+/mi.test(messages)) {
    console.log('[gate] docs-sync: no doc changed, but a commit carries "Docs-Reviewed:" — ok');
    return true;
  }
  console.error('[gate] docs-sync: FAILED — code changed but no project .md doc was updated.');
  for (const f of code.slice(0, 10)) console.error(`         ${f}`);
  if (code.length > 10) console.error(`         … and ${code.length - 10} more`);
  console.error('       Update the affected docs (README.md, PROJECT_STATUS.md, ROADMAP.md,');
  console.error('       PHASE_*_ROADMAP/SIGNOFF.md, *_SPEC.md, packages/*/README.md), or, if truly');
  console.error('       none is needed, add a commit trailer:  Docs-Reviewed: <why no doc change>');
  return false;
}

// ── 2–6. Build / lint / architecture / invariants ─────────────────────────────
const node = process.execPath;
const steps = [
  ['build', ['node_modules/typescript/bin/tsc', '--build']],
  ['lint', ['node_modules/eslint/bin/eslint.js', '.']],
  ['depcruise', ['node_modules/dependency-cruiser/bin/dependency-cruise.mjs', 'packages', '--config', '.dependency-cruiser.cjs']],
  ['invariants', ['node_modules/vitest/vitest.mjs', 'run', 'tests/invariants']],
];
if (process.env.CF_GATE_FULL === '1') steps.push(['full suite', ['node_modules/vitest/vitest.mjs', 'run']]);

if (!docsCheck()) process.exit(1);
for (const [name, args] of steps) {
  console.log(`[gate] ${name} …`);
  const r = spawnSync(node, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[gate] ${name}: FAILED (exit ${r.status ?? r.signal}) — push blocked.`);
    process.exit(1);
  }
}
console.log('[gate] all checks passed.');