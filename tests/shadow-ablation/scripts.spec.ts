/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-shadow-ablation task 8.2 — the Shadow_Runner script (`scripts/run-shadow-ablation.mjs`).
//
//   - `--synthetic --out-dir <tmp>` exits 0 and writes `kernel-shadow-ablation.synthetic.{md,json}`;
//     the JSON parses with `parseReportJson`, re-renders to the written markdown byte for byte
//     (Requirement 10.9), is labelled synthetic, and every reached out-of-policy injection is
//     stopped with no kernel miss (Requirements 10.4, 13.3, 11.4).
//   - an unknown flag is a usage error (exit 1) and writes nothing.
//
// The script runs against the BUILT packages (`packages/*/dist`), so `tsc --build` must have run.
// No model endpoint is contacted: synthetic traces are scripted and replayed (Requirement 13.2).
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReportJson, renderMarkdown } from '@codeforge/testing/shadow-ablation';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..', '..'); // tests/shadow-ablation -> workspace root
const SCRIPT = join(rootDir, 'scripts', 'run-shadow-ablation.mjs');
const SCRIPT_TIMEOUT_MS = 180_000;

const tmpDirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cf-sa-script-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function runScript(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: rootDir, encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('scripts/run-shadow-ablation.mjs', () => {
  it('--synthetic writes a parseable, re-renderable synthetic report with every reached out-of-policy injection stopped', () => {
    const out = tempDir();
    const r = runScript(['--synthetic', '--out-dir', out]);
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);

    const jsonPath = join(out, 'kernel-shadow-ablation.synthetic.json');
    const mdPath = join(out, 'kernel-shadow-ablation.synthetic.md');
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    // The recorded-trace file names are never used by the synthetic form.
    expect(existsSync(join(out, 'kernel-shadow-ablation.json'))).toBe(false);

    const report = parseReportJson(readFileSync(jsonPath, 'utf8'));
    const md = readFileSync(mdPath, 'utf8');
    expect(renderMarkdown(report)).toBe(md);
    expect(report.kind).toBe('synthetic');
    expect(md.split('\n')[0]).toContain('synthetic');

    const s = report.summary;
    expect(s.cases).toBeGreaterThanOrEqual(4);
    expect(s.tracesRefused).toEqual([]);
    expect(s.harnessErrors).toBe(0);
    expect(s.outOfPolicy.reached).toBeGreaterThan(0);
    expect(s.outOfPolicy.stopped).toBe(s.outOfPolicy.reached);
    expect(s.outOfPolicy.missed).toEqual([]);
    expect(s.kernelMisses).toBe(0);
  }, SCRIPT_TIMEOUT_MS + 20_000);

  it('an unknown flag is a usage error (exit 1) and writes no report', () => {
    const out = tempDir();
    const r = runScript(['--synthetic', '--endpoint', 'http://localhost:11434', '--out-dir', out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown flag');
    expect(existsSync(join(out, 'kernel-shadow-ablation.synthetic.json'))).toBe(false);
  }, 60_000);
});
