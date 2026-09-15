// C10 — Phase0Harness + CrashInjector (PHASE_0_ACCEPTANCE §4.2, §4.5).
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Phase0Harness, NoopCrashInjector, CRASH_POINTS } from '@codeforge/testing';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..', '..'); // workspace root (tests/_harness -> up 2)

function harness(): Phase0Harness {
  return new Phase0Harness(rootDir);
}

describe('Phase0Harness — loadInvariants', () => {
  it('parses invariants.yaml with the expected baseline counts', async () => {
    const reg = await harness().loadInvariants();
    expect(reg.invariants.length).toBe(144);
    const critical = reg.invariants.filter((i) => i.severity === 'CRITICAL');
    expect(critical.length).toBeGreaterThanOrEqual(100); // MA-6
    // every entry has the required fields
    for (const inv of reg.invariants) {
      expect(inv.id).toMatch(/^[A-Z]{2}-\d{3}$/);
      expect(inv.enforcement.length).toBeGreaterThan(0);
      expect(inv.test.length).toBeGreaterThan(0);
    }
  });
});

describe('Phase0Harness — runWorkspaceVector', () => {
  it('runs a vector and matches its committed expected hash', async () => {
    const r = await harness().runWorkspaceVector('v002-single-file');
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.hash).toBe(r.expectedHash);
  });

  it('skips a non-applicable vector without failing (recorded reason)', async () => {
    // On Windows, v016 (case-collision) is not applicable; on Linux it runs.
    const r = await harness().runWorkspaceVector('v016-case-collision');
    if (process.platform === 'win32') {
      expect(r.ran).toBe(false);
      expect(r.ok).toBe(true);
      expect(r.reason).toContain('not applicable');
    } else {
      expect(r.ran).toBe(true);
      expect(r.ok).toBe(true);
    }
  });

  it('reports unknown vectors', async () => {
    const r = await harness().runWorkspaceVector('v999-nope');
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe('Phase0Harness — generateReport', () => {
  it('produces a report with all vectors passing (run or safely skipped)', async () => {
    const report = await harness().generateReport();
    expect(report.invariantCount).toBe(144);
    expect(report.criticalCount).toBeGreaterThanOrEqual(100);
    expect(report.vectorsRun + report.vectorsSkipped).toBe(20);
    // every run vector passed
    expect(report.vectorsPassed).toBe(report.vectorsRun);
    // no run vector is marked not-ok
    expect(report.vectorResults.filter((r) => r.ran && !r.ok)).toEqual([]);
  });
});

describe('NoopCrashInjector — CrashInjector interface (Phase 0)', () => {
  it('lists all crash points', () => {
    const ci = new NoopCrashInjector();
    expect(ci.list()).toEqual(CRASH_POINTS);
    expect(ci.list().length).toBe(7);
  });

  it('registers and resets injections without firing them', () => {
    const ci = new NoopCrashInjector();
    let fired = false;
    ci.at('during-transition', () => {
      fired = true;
    });
    expect(ci.registeredCount).toBe(1);
    expect(fired).toBe(false); // noop never fires in Phase 0
    ci.reset();
    expect(ci.registeredCount).toBe(0);
  });
});
