/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Tool module — P1.5-TG1.
// ToolCallStateMachine, ToolPolicy, ToolGateway (TG-001..005, TG-007, TG-009, TG-010).
export {
  transitionToolCall,
  isToolCallTerminal,
  TOOL_CALL_TRANSITIONS,
  TOOL_CALL_EVENT_TO_STATE,
  type ToolCallEvent,
} from './tool-call-machine.js';

export {
  determineAction,
  buildToolPolicy,
  type AutonomyLevel,
  DEFAULT_TOOL_POLICY,
  PERMISSIVE_TEST_POLICY,
  PolicyError,
  type ToolPolicy,
  type ToolRule,
  type PolicyAction,
} from './tool-policy.js';

export {
  ToolGateway,
  ToolGatewayError,
  type ToolGatewayDeps,
  type ToolCallRepository,
  type ToolCallPatch,
  type ApprovalRepository,
  type ToolExecutor,
  type ExecutorResult,
} from './tool-gateway.js';

export {
  ApprovalEngine,
  ApprovalEngineError,
  type ApprovalEngineDeps,
  type ApprovalRequest,
  type OverrideRequest,
  type HumanOverrideRepository,
} from './approval-engine.js';

// Phase 3 — P3-TR1: ToolRegistry
export {
  ToolRegistry,
  ToolRegistryError,
  createDefaultRegistry,
  FILESYSTEM_TOOL_DEFINITIONS,
  type ToolDefinition,
} from './tool-registry.js';

// kernel-gap-closure — Path_Access_Policy (SE-012, WS-011)
export {
  DEFAULT_PATH_ACCESS_POLICY,
  OPEN_PATH_ACCESS_POLICY,
  TEST_LIKE_DIR_SEGMENTS,
  evaluatePathAccess,
  isTestLikePath,
  normalizeSegments,
  type PathAccess,
  type PathAccessCode,
  type PathAccessPolicy,
  type PathAccessVerdict,
} from './path-access-policy.js';

// kernel-gap-closure — Shell_Classifier (TG-011, TG-012, SE-011)
export {
  DESTRUCTIVE_COMMANDS,
  NETWORK_COMMANDS,
  MUTATING_PATH_COMMANDS,
  ENV_EXPANSION_EXEMPT_COMMANDS,
  normalizeInvocation,
  classifyShellInvocation,
  extractShellArguments,
  type ShellInvocation,
  type ShellRisk,
  type ShellArgumentView,
} from './shell-classifier.js';

// kernel-gap-closure — Risk_Classifier (TG-011, TG-012, TG-013)
export {
  resolveToolRiskClass,
  type RiskContext,
  type TestBaseline,
} from './risk-classification.js';

// Phase 3 — P3-SH1: ShellPolicy
export {
  ShellPolicyError,
  DEFAULT_SHELL_ALLOWLIST,
  DEFAULT_SHELL_POLICY,
  createShellPolicy,
  checkCommand,
  resolveTimeout,
  type ShellPolicy,
} from './shell-policy.js';
