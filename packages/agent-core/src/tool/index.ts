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
