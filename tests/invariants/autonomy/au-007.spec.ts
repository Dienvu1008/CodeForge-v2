// AU-007 — Sub-agent output là proposal, không phải authority.
//
// Invariants-first: mirrors MG-006 (model output not authority) / TI-007 (priority is
// a proposal). Contract for P8-MA1: a sub-agent's result is merged as a PROPOSAL that
// the deterministic runtime decides on — it never directly mutates the graph, the
// budget, or task completion.
import { describe, it } from 'vitest';

describe('AU-007 — sub-agent output is a proposal, never authority', () => {
  it.todo('a sub-agent proposal cannot complete a task without CompletionGate (P8-MA1)');
  it.todo('a sub-agent proposal cannot mutate budget or graph directly (P8-MA1)');
});
