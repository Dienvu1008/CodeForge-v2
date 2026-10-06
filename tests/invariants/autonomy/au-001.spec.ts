// AU-001 — Task song song không bypass ToolGateway/Policy — mọi tác động vẫn qua kernel.
//
// Invariants-first (Architecture Target §59): enforcement lands with P8-PX1
// (ParallelExecutor). The contract: the parallel executor only COORDINATES tasks
// through the existing ExecutionCoordinator / ToolGateway / Policy — it opens no
// new path to the filesystem, model, or tools. The base guard already exists
// (TG-001: no tool execution outside ToolGateway); P8-PX1 must not weaken it.
import { describe, it } from 'vitest';

describe('AU-001 — parallel execution never bypasses the kernel', () => {
  it.todo('ParallelExecutor routes every task action through ToolGateway + Policy (P8-PX1)');
  it.todo('adversarial: a parallel branch cannot reach the filesystem outside ToolGateway');
});
