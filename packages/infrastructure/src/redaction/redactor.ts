// Secret redaction — SECURITY_MODEL §7.2, §7.3. Enforces PR-003 / SE-005 / PR-004.
//
// Pure string/JSON transform applied BEFORE anything is persisted to the event log,
// provenance, or artifacts. Conservative and deterministic: same input -> same output,
// no wall-clock, no network. Patterns are copied from SECURITY_MODEL §7.2.

export interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

const PLACEHOLDER = '[REDACTED]';

/**
 * Ordered rules (SECURITY_MODEL §7.2). All use the global flag so every match in a
 * string is replaced. Order matters only for overlapping matches; these are disjoint
 * enough that any order redacts a superset, so we keep the spec's order.
 */
export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    name: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: PLACEHOLDER,
  },
  {
    name: 'bearer',
    pattern: /Bearer\s+[A-Za-z0-9._-]+/g,
    replacement: `Bearer ${PLACEHOLDER}`,
  },
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    replacement: PLACEHOLDER,
  },
  {
    name: 'aws-access-key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: PLACEHOLDER,
  },
  {
    name: 'generic-secret',
    pattern: /(password|secret|token|api[_-]?key)(\s*[:=]\s*['"]?)([^\s'"]+)/gi,
    replacement: `$1$2${PLACEHOLDER}`,
  },
  {
    name: 'connection-string',
    pattern: /(postgres|mysql|mongodb|redis):\/\/[^\s]+/gi,
    replacement: `$1://${PLACEHOLDER}`,
  },
];

/** Redact secrets from a single string (SECURITY_MODEL §7.2). */
export function redact(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    // Reset lastIndex defensively: shared global regexes are stateful.
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Deep-redact a JSON-serializable value. Strings are redacted; objects/arrays are
 * traversed structurally. Returns a new value (does not mutate the input). Non-JSON
 * values (functions, symbols) are dropped by the JSON round-trip contract of callers.
 */
export function redactJson(value: unknown): unknown {
  return redactValue(value);
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}
