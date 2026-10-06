// OB-007 — Activity trace / observability chỉ phơi bày hoạt động + chứng cứ có cấu
// trúc đã redact; không reasoning thô, không secret.
//
// Invariants-first: enforcement lands with P9.4 (ActivityTrace), on top of the already
// enforced PR-003/PR-004 redaction in the EventLog. Contract: a trace entry carries
// objective / action / decision-category / evidence refs / result — never a raw
// chain-of-thought field and never an unredacted secret. The trace is derived from
// already-redacted events, so secrets cannot re-enter via the trace.
import { describe, it } from 'vitest';

describe('OB-007 — activity trace exposes structured evidence, not raw reasoning', () => {
  it.todo('a trace entry has no raw chain-of-thought field (only structured activity) (P9.4)');
  it.todo('trace is built from redacted events — no unredacted secret can appear (P9.4)');
});
