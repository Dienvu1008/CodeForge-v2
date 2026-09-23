// ToolPolicy — SECURITY_MODEL §5, P1.5-TG1.
//
// Deterministic, pure policy engine for tool calls. Enforces:
//   - TG-007: risk class enforced according to policy; DESTRUCTIVE/PRIVILEGED never auto-approve.
//   - SE-009: privileged operations never auto-execute.
//   - SM-003 (policy side): the action decision is a pure function of (toolName, riskClass, policy).
//
// No LLM, no I/O, no wall-clock. Same inputs → same action (deterministic, SM-001).

import type { RiskClass } from '../domain/tool-call.js';

// ── Policy action ─────────────────────────────────────────────────────────────

/**
 * The three possible policy decisions for a tool call.
 *   allow           → auto-approve (directly to APPROVED, no human step).
 *   require_approval → needs human decision (APPROVAL_PENDING).
 *   deny            → immediately DENIED, never executes (TG-005).
 */
export type PolicyAction = 'allow' | 'require_approval' | 'deny';

// ── ToolRule ──────────────────────────────────────────────────────────────────

export interface ToolRule {
  /** Exact tool name, or '*' to match any tool not matched by a specific rule. */
  readonly toolName: string;
  readonly riskClass: RiskClass;
  readonly action: PolicyAction;
  /** Optional path constraints (enforcement by caller / WorkspaceManager). */
  readonly allowedPaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
}

// ── ToolPolicy ────────────────────────────────────────────────────────────────

export interface ToolPolicy {
  readonly policyId: string;
  readonly version: number;
  /** Ordered list of rules — first match wins. */
  readonly rules: readonly ToolRule[];
  /**
   * Action when no specific rule matches (default: 'require_approval').
   * Never 'allow' in production (defense-in-depth).
   */
  readonly defaultAction: PolicyAction;
}

// ── Default policies ──────────────────────────────────────────────────────────

/**
 * Standard production policy (SECURITY_MODEL §5.2).
 * READ_ONLY/LOW_RISK → auto-allow.
 * MODIFY_WORKSPACE/NETWORK → require_approval.
 * PACKAGE_INSTALL/SYSTEM → require_approval.
 * DESTRUCTIVE/PRIVILEGED → deny (TG-007 / SE-009 — never auto).
 */
export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  policyId: 'default-v1',
  version: 1,
  rules: [
    // Wildcard rules by risk class — no specific tool overrides needed for Phase 1.5.
    { toolName: '*', riskClass: 'READ_ONLY',         action: 'allow' },
    { toolName: '*', riskClass: 'LOW_RISK',          action: 'allow' },
    { toolName: '*', riskClass: 'MODIFY_WORKSPACE',  action: 'require_approval' },
    { toolName: '*', riskClass: 'NETWORK',           action: 'require_approval' },
    { toolName: '*', riskClass: 'PACKAGE_INSTALL',   action: 'require_approval' },
    { toolName: '*', riskClass: 'SYSTEM',            action: 'require_approval' },
    // TG-007 / SE-009: these two MUST be deny, never overridden to auto-approve.
    { toolName: '*', riskClass: 'DESTRUCTIVE',       action: 'deny' },
    { toolName: '*', riskClass: 'PRIVILEGED',        action: 'deny' },
  ],
  defaultAction: 'require_approval',
};

/**
 * Permissive policy for integration tests / FakeModel environment.
 * All risk classes except PRIVILEGED auto-approve.
 * DESTRUCTIVE still requires approval (not deny) so tests can exercise that path.
 */
export const PERMISSIVE_TEST_POLICY: ToolPolicy = {
  policyId: 'permissive-test-v1',
  version: 1,
  rules: [
    { toolName: '*', riskClass: 'READ_ONLY',         action: 'allow' },
    { toolName: '*', riskClass: 'LOW_RISK',          action: 'allow' },
    { toolName: '*', riskClass: 'MODIFY_WORKSPACE',  action: 'allow' },
    { toolName: '*', riskClass: 'NETWORK',           action: 'allow' },
    { toolName: '*', riskClass: 'PACKAGE_INSTALL',   action: 'allow' },
    { toolName: '*', riskClass: 'SYSTEM',            action: 'allow' },
    { toolName: '*', riskClass: 'DESTRUCTIVE',       action: 'require_approval' },
    { toolName: '*', riskClass: 'PRIVILEGED',        action: 'deny' }, // SE-009: never
  ],
  defaultAction: 'allow',
};

// ── determineAction ───────────────────────────────────────────────────────────

/**
 * Determine the policy action for a (toolName, riskClass) pair.
 *
 * TG-007 hard override: regardless of policy configuration,
 * DESTRUCTIVE and PRIVILEGED can NEVER be auto-approved. If the policy
 * somehow returns 'allow' for these classes, it is coerced to 'deny'.
 * This is the deterministic runtime enforcement — no LLM or policy
 * file can bypass it (SE-009, SE-003).
 *
 * Rule matching: first matching rule wins; '*' matches any tool.
 */
export function determineAction(
  toolName: string,
  riskClass: RiskClass,
  policy: ToolPolicy,
): PolicyAction {
  // TG-007 / SE-009 hard override — cannot be configured away.
  if (riskClass === 'PRIVILEGED') return 'deny';

  // Find first matching rule.
  for (const rule of policy.rules) {
    if (rule.riskClass !== riskClass) continue;
    if (rule.toolName !== '*' && rule.toolName !== toolName) continue;
    // Match found.
    const action = rule.action;
    // TG-007: DESTRUCTIVE cannot be auto-approved even if a rule says 'allow'.
    if (riskClass === 'DESTRUCTIVE' && action === 'allow') return 'require_approval';
    return action;
  }

  // No rule matched — use default.
  const def = policy.defaultAction;
  if (riskClass === 'DESTRUCTIVE' && def === 'allow') return 'require_approval';
  return def;
}

// ── PolicyError ───────────────────────────────────────────────────────────────

export class PolicyError extends Error {
  public readonly code: 'POLICY_VIOLATION' | 'INVALID_POLICY';
  constructor(code: PolicyError['code'], message?: string) {
    super(message ?? code);
    this.name = 'PolicyError';
    this.code = code;
  }
}
