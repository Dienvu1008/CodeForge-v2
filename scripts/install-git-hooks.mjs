#!/usr/bin/env node
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// install-git-hooks.mjs — copy the versioned hooks in scripts/git-hooks/ into this clone's hooks
// directory (git does not version .git/hooks). Does not touch git config. Re-run after editing a
// hook. Usage: npm run hooks:install
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const hooksDir = resolve(execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim());
mkdirSync(hooksDir, { recursive: true });
for (const name of readdirSync('scripts/git-hooks')) {
  const dest = join(hooksDir, name);
  copyFileSync(join('scripts/git-hooks', name), dest);
  chmodSync(dest, 0o755);
  console.log(`installed ${name} → ${dest}`);
}