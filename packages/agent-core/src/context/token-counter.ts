// TokenCounter — CONTEXT_SPEC §8, P2-CX1.
//
// Pure, deterministic heuristic token counter. No model tokenizer dependency.
// CX-004: token budget must be respected; counting must be deterministic.
//
// Heuristic (§8.3 CONTEXT_SPEC):
//   4 chars ≈ 1 token (English/code) — conservative; better to over-estimate.
//   2 chars ≈ 1 token (Vietnamese/CJK) — detected by Unicode range.
//
// Same input → same output (no randomness, no wall-clock).

/** Estimate the token count for a text string. */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;

  // Sample up to 512 chars to estimate the CJK/non-ASCII ratio.
  const sample = text.slice(0, 512);
  const cjkCount = (sample.match(/[\u3000-\u9fff\uf900-\uffef]/g) ?? []).length;
  const cjkRatio = cjkCount / sample.length;

  // If > 20% CJK/Vietnamese use 2-char-per-token rate; otherwise 4-char-per-token.
  const charsPerToken = cjkRatio > 0.2 ? 2 : 4;
  return Math.ceil(text.length / charsPerToken);
}

/** Estimate tokens for a system + task prompt pair (used for budget reservation). */
export function countPromptTokens(systemPrompt: string, taskPrompt: string): number {
  // Add a small overhead for separators and metadata.
  return countTokens(systemPrompt) + countTokens(taskPrompt) + 8;
}
