// PlanValidator — P2-PL1. Thin deterministic wrapper over GraphValidator.
//
// Validates a GraphMutation before it is committed. Pure + deterministic (no LLM).
// Reuses the existing GraphValidator (GI-002/004..007) so plan validation is
// identical to graph mutation validation — one source of truth.
import { validateMutation, type ValidationResult, type ValidationContext } from '../graph/validator.js';
import type { TaskGraph, GraphMutation } from '../graph/types.js';

export type { ValidationResult, ValidationContext };

export class PlanValidationError extends Error {
  public readonly errors: ValidationResult['errors'];
  constructor(result: ValidationResult) {
    super(`Plan validation failed: ${result.errors.map((e) => e.message).join('; ')}`);
    this.name = 'PlanValidationError';
    this.errors = result.errors;
  }
}

export class PlanValidator {
  /**
   * Validate a GraphMutation against the current graph.
   * Returns the ValidationResult — callers check `result.status === 'VALIDATED'`.
   * Does NOT throw; callers decide what to do with REJECTED mutations.
   */
  validate(
    graph:    TaskGraph,
    mutation: GraphMutation,
    ctx:      ValidationContext = {},
  ): ValidationResult {
    return validateMutation(graph, mutation, ctx);
  }

  /**
   * Validate and throw PlanValidationError if REJECTED.
   * Convenience for callers that want fail-fast behavior.
   */
  validateOrThrow(
    graph:    TaskGraph,
    mutation: GraphMutation,
    ctx:      ValidationContext = {},
  ): ValidationResult {
    const result = this.validate(graph, mutation, ctx);
    if (result.status === 'REJECTED') {
      throw new PlanValidationError(result);
    }
    return result;
  }
}
