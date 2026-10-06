// OB-005 — Runtime projection / read-model không phải authority; không có đường ghi
// vào state authoritative.
//
// Invariants-first (Architecture Target §59): enforcement lands with P9.2
// (RuntimeProjection). Contract: the projection is a PURE reducer of authoritative
// inputs (repository DTOs + EventLog) → a read-model DTO. It exposes no mutator, holds
// no repository write handle, and the dashboard consuming it cannot write back. The
// authoritative state remains Session/TaskExecution/TaskRun/TaskGraph/Budget/
// Verification + EventLog — the projection only derives a view of them.
import { describe, it } from 'vitest';

describe('OB-005 — runtime projection is not authority', () => {
  it.todo('RuntimeProjection is a pure reducer — no mutator, no repository write handle (P9.2)');
  it.todo('a projection DTO carries only read data; consuming it cannot mutate authoritative state (P9.2)');
});
