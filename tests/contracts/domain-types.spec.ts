// T7 — Domain type conformance (DT-1..DT-20). DOMAIN_CONTRACTS §2-§20.
//
// These tests are primarily COMPILE-TIME: if the exported types drift from the
// contract, `tsc --build` (npm run typecheck) fails before Vitest even runs.
// Typed literal constructors below act as executable spec fixtures; runtime `expect`s
// spot-check the few values that carry semantic weight (enums, lattices).
import { describe, it, expect } from 'vitest';
import type {
  Session,
  Task,
  TaskExecution,
  TaskRun,
  VerificationReport,
  VerificationScope,
  ToolCall,
  RiskClass,
  Approval,
} from '@codeforge/agent-core';
import type { TaskStrategy, WorkspaceRevision } from '@codeforge/agent-core';
import { SCOPE_LATTICE } from '@codeforge/agent-core';

// Helper: assert a value conforms to T at compile time, return it for runtime checks.
function conforms<T>(value: T): T {
  return value;
}

const STRATEGY: TaskStrategy = { kind: 'generate' };

const PROVENANCE = {
  provenanceId: 'P',
  source: { kind: 'model' as const, id: 'planner' },
  inputs: [] as readonly string[],
  reason: 'test fixture',
  at: '2026-01-01T00:00:00.000Z',
};

const REVISION: WorkspaceRevision = {
  revisionId: 'rev',
  canonicalFormVersion: 'v1',
  root: '/abs',
  includedPaths: [],
  excludedScratchPaths: [],
  hashAlgorithm: 'blake3',
  hash: 'deadbeef',
  fileCount: 0,
  totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

describe('domain type conformance (T7 / DT-1..DT-20)', () => {
  it('DT-2: Session carries lifecycle state + workspace identity (DOMAIN_CONTRACTS §2)', () => {
    const s = conforms<Session>({
      sessionId: 'S',
      workspaceId: 'W',
      workspaceRoot: '/abs',
      goalId: 'G',
      graphVersion: 1,
      state: 'RUNNING',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      runtimeVersion: '0.0.0',
      schemaVersion: 1,
      budgetId: 'B',
      lockId: 'L',
      metadata: {
        hostname: 'h',
        processId: 1,
        ollamaEndpoint: 'http://localhost:11434',
        ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' },
      },
    });
    expect(s.graphVersion).toBe(1);
  });

  it('DT-4/TI-001..003: Task is intent only — no deps/state/runs/verification fields', () => {
    const t = conforms<Task>({
      taskId: 'T',
      description: 'do a thing',
      acceptanceCriteria: [],
      constraints: [],
      priority: 0,
      strategy: STRATEGY,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'planner',
    });
    // A Task must NOT expose runtime concerns. These keys are absent by contract.
    expect('currentState' in t).toBe(false);
    expect('dependencies' in t).toBe(false);
    expect('runs' in t).toBe(false);
    expect('verification' in t).toBe(false);
  });

  it('DT-5: TaskExecution is the mutable projection (holds currentState)', () => {
    const e = conforms<TaskExecution>({
      taskId: 'T',
      currentState: 'READY',
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(e.currentState).toBe('READY');
  });

  it('DT-6: TaskRun records revisions at start/end + budget consumed', () => {
    const run = conforms<TaskRun>({
      taskRunId: 'R',
      taskId: 'T',
      sessionId: 'S',
      attemptNumber: 1,
      state: 'SUCCEEDED',
      graphVersionAtStart: 1,
      workspaceRevisionAtStart: REVISION,
      strategyUsed: STRATEGY,
      startedAt: '2026-01-01T00:00:00.000Z',
      toolCalls: [],
      failures: [],
      budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    });
    expect(run.attemptNumber).toBe(1);
  });

  it('DT-9: VerificationReport binds to a target revision + scope lattice ordered', () => {
    const scopes: VerificationScope[] = ['FULL', 'AFFECTED_CLOSURE', 'AFFECTED_DIRECT', 'SMOKE'];
    expect(scopes).toHaveLength(4);
    // VERIFICATION_PROTOCOL: FULL is the strongest scope, SMOKE the weakest.
    expect(SCOPE_LATTICE.FULL).toBeGreaterThan(SCOPE_LATTICE.AFFECTED_CLOSURE);
    expect(SCOPE_LATTICE.AFFECTED_CLOSURE).toBeGreaterThan(SCOPE_LATTICE.AFFECTED_DIRECT);
    expect(SCOPE_LATTICE.AFFECTED_DIRECT).toBeGreaterThan(SCOPE_LATTICE.SMOKE);

    const r = conforms<VerificationReport>({
      verificationId: 'V',
      sessionId: 'S',
      taskId: 'T',
      taskRunId: 'R',
      targetWorkspaceRevision: REVISION,
      canonicalFormVersion: 'v1',
      scope: 'FULL',
      checks: [],
      status: 'PASS',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:00.000Z',
      toolVersions: {},
      artifacts: [],
      invariantsChecked: [],
      schemaVersion: 1,
    });
    expect(r.status).toBe('PASS');
  });

  it('DT-12/13: ToolCall carries riskClass + argumentsHash; Approval binds to that hash', () => {
    const risks: RiskClass[] = [
      'READ_ONLY',
      'LOW_RISK',
      'MODIFY_WORKSPACE',
      'NETWORK',
      'PACKAGE_INSTALL',
      'SYSTEM',
      'DESTRUCTIVE',
      'PRIVILEGED',
    ];
    expect(risks).toHaveLength(8);

    const approval = conforms<Approval>({
      approvalId: 'AP',
      toolCallId: 'TC',
      binding: { argumentsHash: 'HASH', toolPolicyVersion: 1 },
      decision: 'APPROVED',
      decidedBy: 'user',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    const tc = conforms<ToolCall>({
      toolCallId: 'TC',
      sessionId: 'S',
      toolName: 'run',
      toolVersion: '1',
      riskClass: 'DESTRUCTIVE',
      arguments: { cmd: 'rm' },
      argumentsHash: 'HASH',
      state: 'APPROVED',
      approval,
      proposedBy: 'model',
      provenance: PROVENANCE,
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    // Approval binding hash must reference the same canonical arguments hash (SE binding).
    expect(tc.approval?.binding.argumentsHash).toBe(tc.argumentsHash);
    expect(tc.proposedBy).toBe('model'); // model proposes, runtime decides
  });
});
