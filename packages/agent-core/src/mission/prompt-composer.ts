// PromptComposer — Phase 12 (P12.8). §17. Deterministic, PURE assembly of prompt-shaping hints
// from a Mission, so the executor/planner prompt ADAPTS to the task type, complexity, and the
// model's strength instead of being one static string for every task and every model.
//
// Design law (MI-001 / "LLM proposes, the runtime decides"): this NEVER calls an LLM to rewrite a
// prompt. It only SELECTS and ASSEMBLES pre-authored prompt blocks from mission signals. That
// keeps it deterministic (same mission → same plan), adds no extra model round-trip, and opens no
// injection surface. The blocks it produces are GUIDANCE/DATA for the model — never authority
// (MI-008, SE-010): tools, approvals, and verification stay with the deterministic runtime.
//
// Fail-safe (MI-002): callers treat a missing PromptPlan as "use the default static prompt". When
// no mission runs, nothing here executes and the prompt is byte-identical to before.
import type { Mission, MissionType, ExpertProfile, ModelRequirement } from '../domain/mission.js';
import { renderExpertProfile } from './expert-profile.js';

// ── PromptPlan ─────────────────────────────────────────────────────────────────

/** How talkative/guard-railed the prompt should be, chosen from the model's strength. */
export type PromptVerbosity = 'terse' | 'normal' | 'guarded';

/**
 * The flattened, serializable prompt-shaping hints threaded (like ContextPlan / assumptions)
 * through the orchestrator to each TaskExecutorRequest. Every field is optional: a consumer
 * applies what is present and ignores the rest, so partial plans and absent plans both degrade
 * safely to the default prompt.
 */
export interface PromptPlan {
  /** Persona + constraints + preferred practices (rendered from the mission's ExpertProfile). */
  readonly expertPersona?: string;
  /** Short, task-type-specific guidance (how to approach a BUG_FIX vs a REFACTOR vs a FEATURE). */
  readonly taskTypeGuidance?: string;
  /** Id of a pre-authored few-shot example matching the task type (looked up by the consumer). */
  readonly fewShotExampleId?: string;
  /** Prompt verbosity, chosen from the model's strength + task complexity. */
  readonly verbosity?: PromptVerbosity;
}

// ── Task-type guidance (pre-authored, data not code) ─────────────────────────────
// One short paragraph per mission type. Deliberately terse so it steers without bloating the
// prompt (prompt bloat hurts weak local models — the whole point is net-positive steering).

const TASK_TYPE_GUIDANCE: Partial<Record<MissionType, string>> = {
  BUG_FIX:
    'This is a BUG FIX. Find the ROOT CAUSE of the failure, then make the SMALLEST change that ' +
    'fixes it. Do not refactor unrelated code or change tests to match the bug — fix the source.',
  FEATURE:
    'This is a FEATURE. Add the new behavior while keeping all existing behavior intact. Match the ' +
    'existing code style and exports; add only what the acceptance criteria require.',
  REFACTOR:
    'This is a REFACTOR. Preserve observable behavior exactly. Update EVERY caller of anything you ' +
    'rename or move. Run the tests before and after if a test command exists.',
  TESTING:
    'This is a TESTING task. Write tests that actually exercise the described behavior and assert ' +
    'concrete outcomes. The test must run and pass against the real code — do not stub the thing under test.',
  MIGRATION:
    'This is a MIGRATION. Make the change additively and reversibly where possible. Keep behavior ' +
    'unchanged; update all references to the moved/renamed symbol.',
  DOCUMENTATION:
    'This is a DOCUMENTATION task. State only facts you can verify from the code. Identify concrete ' +
    'files, names, and values rather than describing them vaguely.',
  PERFORMANCE:
    'This is a PERFORMANCE task. Keep behavior identical; change only what affects the hot path. ' +
    'Prefer a measured, localized optimization over a broad rewrite.',
  ARCHITECTURE:
    'This is an ARCHITECTURE task. Respect module boundaries and dependency direction. Keep the ' +
    'public behavior and tests passing while moving the internal structure.',
  PROJECT:
    'This is a PROJECT-GENERATION task from a (near-)empty workspace. Create the minimal set of ' +
    'files that satisfies the goal and runs; do not scaffold unused structure.',
};

/** Few-shot example ids per mission type (the consumer resolves the id to example text). */
const FEW_SHOT_BY_TYPE: Partial<Record<MissionType, string>> = {
  BUG_FIX:  'example-bugfix',
  FEATURE:  'example-feature',
  REFACTOR: 'example-refactor',
  TESTING:  'example-testing',
};

// ── Verbosity selection ──────────────────────────────────────────────────────────

/**
 * Choose prompt verbosity from the model's strength + task complexity:
 *   - 'guarded' for weak/latency-sensitive coders (LOW coding, or latencySensitive): more
 *     guard-rails, blunter "one action per step" nudges — weak local models need the scaffolding.
 *   - 'terse' for strong reasoners on simple work (HIGH reasoning + non-SYSTEM complexity):
 *     trust the model, cut repetition.
 *   - 'normal' otherwise.
 * Pure + total.
 */
export function selectVerbosity(req: ModelRequirement, complexity: Mission['complexity']): PromptVerbosity {
  if (req.coding === 'LOW' || req.latencySensitive) return 'guarded';
  if (req.reasoning === 'HIGH' && complexity.level !== 'SYSTEM') return 'terse';
  return 'normal';
}

// ── Composer ─────────────────────────────────────────────────────────────────────

/**
 * Compose a PromptPlan from a mission + the selected expert profile. Pure + deterministic: same
 * inputs → same plan. Advisory only (MI-008): the plan is prompt GUIDANCE, never authority.
 */
export function composePromptPlan(mission: Mission, expertProfile: ExpertProfile): PromptPlan {
  const guidance = TASK_TYPE_GUIDANCE[mission.missionType];
  const fewShot = FEW_SHOT_BY_TYPE[mission.missionType];
  const verbosity = selectVerbosity(mission.modelRequirement, mission.complexity);
  return {
    expertPersona: renderExpertProfile(expertProfile),
    ...(guidance !== undefined ? { taskTypeGuidance: guidance } : {}),
    ...(fewShot !== undefined ? { fewShotExampleId: fewShot } : {}),
    verbosity,
  };
}

// ── Few-shot example resolution (consumer-side, pure) ─────────────────────────────
// Pre-authored, compact examples. Each shows the DESIRED shape of work for its task type. Kept
// short on purpose (a long example bloats the prompt and can mislead a weak model into copying it
// verbatim). Returns undefined for an unknown id (consumer then omits the EXAMPLE section).

const FEW_SHOT_EXAMPLES: Record<string, string> = {
  'example-bugfix':
    'Example (bug fix): a loop used `i < n` where it needed `i <= n`. The fix was a single ' +
    'operator change in the source function — no test edits, no unrelated changes.',
  'example-feature':
    'Example (feature): to add `isEven(n)`, append the exported function to the existing module ' +
    'and keep every current export; then run the test command once.',
  'example-refactor':
    'Example (refactor): renaming `calc`→`computeTotal` meant updating the definition AND its ' +
    'importer in another file, then confirming the tests still pass. Behavior unchanged.',
  'example-testing':
    'Example (testing): a test required the module, called the function, and asserted a concrete ' +
    'value (e.g. `reverse("abc") === "cba"`), then printed ok so the command exits 0.',
};

/** Resolve a few-shot example id to its text, or undefined when unknown. Pure. */
export function resolveFewShotExample(id: string): string | undefined {
  return FEW_SHOT_EXAMPLES[id];
}
