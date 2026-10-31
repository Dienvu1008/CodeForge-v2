/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// MissionIntelligence — Phase 12 (P12.7). The optional pre-planning stage that assembles a
// Mission from the deterministic analyzers, (for complex missions) proposes an architecture and
// runs the deterministic ArchitectureGate, emits MISSION_* audit events, and returns an ADVISORY
// outcome to the orchestrator.
//
// Authority rules (the whole point of Phase 12):
//   MI-001: everything here is ADVISORY. The stage produces recommendations + a gate verdict; it
//           NEVER mutates filesystem/policy/approval/task-state and never decides execution.
//   MI-002: the stage is OPTIONAL. When the orchestrator does not wire it (`--mission off`),
//           behavior is byte-identical to Phase 11. Wiring it adds analysis + events only.
//   MI-004: the stage does NOT mutate the Goal and does NOT create Tasks/Graph (only Planner +
//           GraphCommit do that, GI-009). It reads the Goal and emits events.
//   MI-003/MI-006/MI-007: capabilities are VERIFIED via the injected probe (never LLM claims);
//           model routing stays within a real registry; the ArchitectureGate decides PASS/BLOCK.
//
// Pure orchestration over injected contracts (EventLog, clock, id source) + optional advisory
// collaborators (architect, capability discovery, model registry). No infrastructure import.
import type { Goal } from '../domain/goal.js';
import type { EventLog } from '../repositories/index.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type {
  Mission,
  MissionType,
  ContextScope,
  Architecture,
  ArchitectureGateResult,
  PreflightReport,
  ExpertProfile,
  Capability,
  GoalClarification,
} from '../domain/mission.js';
import type { AcceptanceCriterion } from '../domain/common.js';
import { AssumptionAdvisor } from './assumption-advisor.js';
import { extractSignals, type WorkspaceSignals } from './signals.js';
import { classifyMissionType } from './mission-intake.js';
import { assessComplexity } from './complexity-analyzer.js';
import { assessRisk } from './risk-analyzer.js';
import { assessUncertainty } from './uncertainty-analyzer.js';
import { decidePlanningMode } from './planning-router.js';
import { decideContextStrategy, toContextPlan, type ContextStrategy, type ContextPlan } from './mission-context-strategy.js';
import { composePromptPlan, type PromptPlan } from './prompt-composer.js';
import { selectExpertProfile } from './expert-profile.js';
import { analyzeModelRequirement, routeModel, type ModelRegistry, type RoutingOutcome } from './model-router.js';
import { MissionArchitect } from './mission-architect.js';
import { evaluateArchitecture } from './architecture-gate.js';
import type { CapabilityDiscovery } from './capability-discovery.js';
import {
  buildClarificationRequest,
  mergeClarificationAnswers,
  type ClarificationGate,
  type ClarificationOutcome,
  type ClarificationRequest,
} from './goal-clarification.js';

// ── Optional collaborators (all advisory; absent → that step is skipped) ─────────

export interface MissionIntelligenceDeps {
  /** Audit sink for MISSION_* events (OB-*). The ONLY required side-effecting dep. */
  readonly events: EventLog;
  readonly now: () => string;
  readonly newId: () => string;

  /**
   * Optional capability discovery (verifies tools via ProcessSupervisor — MI-003). When present,
   * the stage builds a PreflightReport; the ArchitectureGate consumes it. Absent → an empty
   * preflight (no verified capabilities), which simply means a capability-requiring architecture
   * will BLOCK (fail-closed, correct for MI-003).
   */
  readonly capabilityDiscovery?: CapabilityDiscovery;
  /** Capability names to probe/verify for this run (defaults to none). */
  readonly requiredCapabilities?: readonly string[];

  /** Optional model registry (MI-006). When present, the stage routes + emits MODEL_SELECTED. */
  readonly modelRegistry?: ModelRegistry;
  /** Optional preferred model id (ignored if not registered — MI-006). */
  readonly preferredModelId?: string;

  /**
   * Optional architect (LLM blueprint for complex missions — MI-001). When present AND the
   * mission needs architecture, the stage proposes a blueprint and runs the ArchitectureGate.
   * Absent → no blueprint, gate not run, mission still produced (advisory).
   */
  readonly architect?: MissionArchitect;

  /**
   * Optional Tier B1 assumption advisor (LLM). When present AND the goal is under-specified
   * (uncertainty ≥ INFERRED), the stage asks it to make EXPLICIT assumptions and a clarified
   * restatement (option (ii): assume + state, don't stop to ask). Absent / on error → skipped,
   * the mission proceeds unchanged (fail-safe). The clarification is advisory (MI-001) and is
   * mirrored into the Mission's acceptanceCriteria copy only — never into the Goal (MI-004).
   */
  readonly assumptionAdvisor?: AssumptionAdvisor;

  /**
   * Optional goal clarification gate (opt-in `--clarify on`). When present AND the goal is
   * UNKNOWN with open questions, the stage ASKS the user (GOAL_CLARIFICATION_REQUESTED → wait →
   * GOAL_CLARIFICATION_ANSWERED) and the advisor only assumes for the skipped questions.
   * Absent ⇒ the existing Tier B1 assume-and-state path, unchanged (MI-002 parity).
   */
  readonly clarificationGate?: ClarificationGate;

  /** Optional workspace signals (languages/fileCount) to sharpen complexity analysis. */
  readonly workspaceSignals?: WorkspaceSignals;
}

/** session-resume v1: resume an open clarification instead of starting the stage from scratch. */
export interface MissionAnalyzeOptions {
  /**
   * The open request (and its missionId) rebuilt from the session's GOAL_CLARIFICATION_REQUESTED
   * event. The stage recomputes its deterministic analysis SILENTLY (no re-emission of the events
   * already in the log — MI-005 makes the result identical), waits on this SAME request, and from
   * the answer onward emits exactly as a fresh run does.
   */
  readonly resumeClarification?: { readonly missionId: string; readonly request: ClarificationRequest };
}

// ── Outcome ──────────────────────────────────────────────────────────────────────

export interface MissionStageOutcome {
  /**
   * Whether planning may proceed. false ONLY when the ArchitectureGate BLOCKed — the orchestrator
   * must then stop and move the session to AWAITING_HUMAN (MI-007) — or when the user cancelled
   * while the clarification gate was waiting (blocker 'clarification cancelled'). true in every other case
   * (including when no architect/gate ran — advisory analysis never blocks on its own, MI-001).
   */
  readonly proceed: boolean;
  readonly mission: Mission;
  readonly contextStrategy: ContextStrategy;
  /**
   * P12.7 context wiring: the FLATTENED, serializable context plan (scope + maxFiles +
   * repositoryWide) derived from `contextStrategy`. This is the field the orchestrator threads
   * into each TaskExecutorRequest so the context pipeline is bounded per the mission. Always
   * present (contextStrategy is always computed); kept separate from the richer contextStrategy
   * (which also carries a human-readable `reason` for events/dashboard).
   */
  readonly contextPlan: ContextPlan;
  /**
   * P12.8 prompt shaping: deterministic prompt-guidance hints (expert persona + task-type
   * guidance + few-shot id + verbosity) composed from the mission. Threaded into each
   * TaskExecutorRequest so the executor prompt ADAPTS to the task + model instead of being
   * static. Advisory (MI-008): guidance/data for the model, never authority.
   */
  readonly promptPlan: PromptPlan;
  /** The selected model routing (undefined when no registry was wired). */
  readonly routing?: RoutingOutcome;
  /**
   * P12.9 mission-driven routing: the model id the router chose for this mission (from `routing`
   * when kind is 'selected' or 'fallback'; undefined on 'escalate' or when no registry was wired).
   * The orchestrator passes this id to an optional RuntimeModelSelector so the runtime can switch
   * the active model to fit the mission. Advisory (MI-006): a recommendation the runtime applies;
   * the id is a plain string — the agent-core layer never knows the provider/endpoint/key (DC-002).
   */
  readonly selectedModelId?: string;
  readonly expertProfile: ExpertProfile;
  readonly preflight?: PreflightReport;
  readonly architecture?: Architecture;
  readonly gate?: ArchitectureGateResult;
  /** Tier B1: assumptions the agent made for an under-specified goal (undefined when none). */
  readonly clarification?: GoalClarification;
  /**
   * Tier B2: the assumption STATEMENTS flattened from `clarification.assumptions` (each entry
   * is a GoalAssumption.assumption string). Present only when assumptions were made. This is the
   * field the orchestrator reads to satisfy MissionStageDecision.assumptions and thread the
   * assumptions into every TaskExecutorRequest, so the agent proceeds under them (option (ii)).
   */
  readonly assumptions?: readonly string[];
  /** Blockers that forced proceed=false (empty when proceed=true). */
  readonly blockers: readonly string[];
}

// ── MissionIntelligence stage ─────────────────────────────────────────────────────

export class MissionIntelligence {
  /** session-resume: sessions whose pre-gate events are already logged (emit() is muted for them). */
  private readonly quiet = new Set<string>();

  constructor(private readonly deps: MissionIntelligenceDeps) {}

  /**
   * Analyze a Goal into a Mission + advisory recommendations, emitting MISSION_* events along the
   * way. Returns an outcome telling the orchestrator whether to proceed to planning. Never throws
   * for advisory reasons — if the optional architect LLM call fails, the stage logs and proceeds
   * (advisory layer must not break the run; MI-002 fail-safe spirit).
   */
  async analyze(sessionId: string, goal: Goal, options?: MissionAnalyzeOptions): Promise<MissionStageOutcome> {
    const resume = options?.resumeClarification;
    if (resume === undefined) return this.analyzeInner(sessionId, goal, this.deps.newId(), undefined);
    this.quiet.add(sessionId);
    try {
      return await this.analyzeInner(sessionId, goal, resume.missionId, resume.request);
    } finally {
      this.quiet.delete(sessionId);
    }
  }

  private async analyzeInner(
    sessionId: string,
    goal: Goal,
    missionId: string,
    resumeRequest: ClarificationRequest | undefined,
  ): Promise<MissionStageOutcome> {
    await this.emit(sessionId, 'MISSION_RECEIVED', missionId, { goalId: goal.goalId, description: goal.description });

    // ── Deterministic classification (MI-005) ──────────────────────────────────
    const signals = extractSignals(goal.description, this.deps.workspaceSignals);
    const typeResult = classifyMissionType(signals);
    const missionType: MissionType = typeResult.type === 'UNKNOWN' ? 'FEATURE' : typeResult.type;
    await this.emit(sessionId, 'MISSION_CLASSIFIED', missionId, { missionType, matchedKeyword: typeResult.matchedKeyword });

    const complexity = assessComplexity(signals, missionType);
    await this.emit(sessionId, 'MISSION_COMPLEXITY_ESTIMATED', missionId, { level: complexity.level, reasons: complexity.reasons });

    const risk = assessRisk(signals);
    await this.emit(sessionId, 'MISSION_RISK_ASSESSED', missionId, { level: risk.level, factors: risk.factors });

    // Tier A: deterministic goal-ambiguity assessment (replaces the old hard-coded KNOWN). A
    // precise goal (clear I/O + acceptance) scores KNOWN; a vague one (no acceptance, open-ended
    // wording, no I/O) scores UNKNOWN with concrete openQuestions. Advisory for now — it makes
    // the Mission.uncertainty field real so the UI can surface it and a later clarification step
    // (Tier B/C) can act on it.
    const uncertainty = assessUncertainty(signals, missionType, goal.acceptanceCriteria);
    await this.emit(sessionId, 'MISSION_UNCERTAINTY_ASSESSED', missionId, {
      level: uncertainty.level, openQuestions: uncertainty.openQuestions,
    });

    // ── Capability verification (MI-003) ────────────────────────────────────────
    let preflight: PreflightReport | undefined;
    const required = this.deps.requiredCapabilities ?? [];
    if (this.deps.capabilityDiscovery !== undefined) {
      let machine: readonly Capability[] = [];
      try {
        machine = await this.deps.capabilityDiscovery.discover();
        await this.emit(sessionId, 'MISSION_ENVIRONMENT_DISCOVERED', missionId, { count: machine.length });
        const aiModels = this.deps.modelRegistry?.list().map((m) => m.id) ?? [];
        preflight = this.deps.capabilityDiscovery.buildPreflight(missionId, machine, [], aiModels, required);
        for (const cap of machine) {
          if (cap.status === 'VERIFIED') {
            await this.emit(sessionId, 'MISSION_CAPABILITY_VERIFIED', missionId, { name: cap.name, version: cap.version });
          }
        }
      } catch {
        // Capability discovery is advisory evidence-gathering; a probe failure must not break the
        // stage. Leave preflight undefined (fail-closed: capability-requiring arch will BLOCK).
      }
    }

    // ── Build the advisory Mission aggregate (MI-004: references the Goal, never mutates it) ──
    const contextScope: ContextScope = inferContextScope(missionType, complexity.level, signals.multiRepo);
    const partialForMode: Mission = this.assembleMission({
      missionId, goal, missionType, complexity, risk, contextScope, uncertainty,
      // planningMode/architectureRequirement filled by refinement below; seed with placeholders.
      planningMode: 'DIRECT', architectureRequirement: 'NOT_REQUIRED',
    });
    const archRequirement = deriveArchitectureRequirement(missionType, complexity.level);
    const missionWithArch: Mission = { ...partialForMode, architectureRequirement: archRequirement };
    const planning = decidePlanningMode(missionWithArch);
    await this.emit(sessionId, 'MISSION_PLANNING_MODE_SELECTED', missionId, { mode: planning.mode, reason: planning.reason });

    // ── Tier B1 / clarification gate: resolve goal ambiguity (assume-and-state or ask) ──
    const resolved = await this.resolveAmbiguity(
      sessionId, missionId, goal, { ...missionWithArch, planningMode: planning.mode }, resumeRequest,
    );
    const mission: Mission = resolved.mission;
    const clarification: GoalClarification | undefined = resolved.clarification;
    const assumptionStatements: readonly string[] = resolved.statements;

    const contextStrategy = decideContextStrategy(mission);
    const contextPlan = toContextPlan(contextStrategy);
    const expertProfile = selectExpertProfile(missionType, goal.description, this.deps.workspaceSignals);
    const promptPlan = composePromptPlan(mission, expertProfile);

    // The user cancelled while the clarification gate was waiting: stop before routing/architect
    // (no further LLM calls). The orchestrator treats proceed=false as "do not plan".
    if (resolved.cancelled) {
      return {
        proceed: false,
        mission, contextStrategy, contextPlan, promptPlan, expertProfile,
        blockers: ['clarification cancelled'],
        ...(preflight !== undefined ? { preflight } : {}),
      };
    }

    // ── Model routing (MI-006) ──────────────────────────────────────────────────
    let routing: RoutingOutcome | undefined;
    if (this.deps.modelRegistry !== undefined) {
      const req = analyzeModelRequirement(mission);
      routing = routeModel(req, this.deps.modelRegistry, this.deps.preferredModelId);
      await this.emit(sessionId, 'MISSION_MODEL_SELECTED', missionId, {
        kind: routing.kind,
        modelId: routing.kind === 'escalate' ? undefined : routing.model.id,
        reason: routing.reason,
      });
    }
    // P12.9: the model id to apply at runtime (undefined on escalate / no registry). Fail-safe.
    const selectedModelId: string | undefined =
      routing !== undefined && routing.kind !== 'escalate' ? routing.model.id : undefined;

    // ── Architecture + gate (MI-001 proposal, MI-007 deterministic verdict) ──────
    let architecture: Architecture | undefined;
    let gate: ArchitectureGateResult | undefined;
    const needsArch = MissionArchitect.needsArchitecture(mission);
    if (needsArch && this.deps.architect !== undefined) {
      const pf = preflight ?? emptyPreflight(missionId, this.deps.now());
      try {
        const verifiedNames = [...pf.machine, ...pf.workspace]
          .filter((c) => c.status === 'VERIFIED')
          .map((c) => c.name);
        architecture = await this.deps.architect.architect(mission, expertProfile, verifiedNames);
        await this.emit(sessionId, 'MISSION_ARCHITECTURE_PROPOSED', missionId, {
          summary: architecture.summary,
          modules: architecture.moduleBoundaries.length,
          requiredCapabilities: architecture.requiredCapabilities,
        });
        gate = evaluateArchitecture(architecture, mission, pf);
        if (gate.verdict === 'PASS') {
          await this.emit(sessionId, 'MISSION_ARCHITECTURE_GATE_PASSED', missionId, { reasons: gate.reasons });
        } else {
          await this.emit(sessionId, 'MISSION_ARCHITECTURE_GATE_BLOCKED', missionId, { blockers: gate.blockers });
          await this.emit(sessionId, 'MISSION_USER_CONFIRMATION_REQUIRED', missionId, { blockers: gate.blockers });
          return {
            proceed: false,
            mission, contextStrategy, contextPlan, promptPlan, expertProfile,
            architecture, gate, blockers: gate.blockers,
            ...(routing !== undefined ? { routing } : {}),
            ...(selectedModelId !== undefined ? { selectedModelId } : {}),
            ...(preflight !== undefined ? { preflight } : {}),
            ...(clarification !== undefined ? { clarification } : {}),
            ...(assumptionStatements.length > 0 ? { assumptions: assumptionStatements } : {}),
          };
        }
      } catch {
        // The architect LLM call failed (timeout / invalid output after retries). Advisory layer
        // must not break the run: skip the blueprint and proceed to planning (MI-001/MI-002).
      }
    }

    return {
      proceed: true,
      mission, contextStrategy, contextPlan, promptPlan, expertProfile,
      blockers: [],
      ...(routing !== undefined ? { routing } : {}),
      ...(selectedModelId !== undefined ? { selectedModelId } : {}),
      ...(preflight !== undefined ? { preflight } : {}),
      ...(architecture !== undefined ? { architecture } : {}),
      ...(gate !== undefined ? { gate } : {}),
      ...(clarification !== undefined ? { clarification } : {}),
      ...(assumptionStatements.length > 0 ? { assumptions: assumptionStatements } : {}),
    };
  }

  // ── Goal ambiguity resolution ─────────────────────────────────────────────────

  /**
   * Resolve an under-specified goal. Two paths:
   *  - Clarification gate (opt-in `--clarify on`): when a gate is wired AND the goal is UNKNOWN
   *    with open questions, ASK the user, merge the answers as `[user-provided]` statements, and
   *    let the advisor assume only for the skipped questions.
   *  - Tier B1 (default): assume-and-state via the advisor, unchanged (MI-002 parity).
   * Only the Mission COPY and the returned statements change — never the Goal (MI-004).
   */
  private async resolveAmbiguity(
    sessionId: string,
    missionId: string,
    goal: Goal,
    mission: Mission,
    resumeRequest?: ClarificationRequest,
  ): Promise<{
    readonly mission: Mission;
    readonly clarification?: GoalClarification;
    readonly statements: readonly string[];
    readonly cancelled: boolean;
  }> {
    const gate = this.deps.clarificationGate;
    if (resumeRequest !== undefined || (gate !== undefined && mission.uncertainty.level === 'UNKNOWN' && mission.uncertainty.openQuestions.length > 0)) {
      let request: ClarificationRequest;
      if (resumeRequest !== undefined) {
        // session-resume: the request is already logged — wait on the SAME one, then emit normally.
        request = resumeRequest;
        this.quiet.delete(sessionId);
      } else {
        request = buildClarificationRequest(this.deps.newId(), missionId, goal.goalId, mission.uncertainty.openQuestions);
        await this.emit(sessionId, 'GOAL_CLARIFICATION_REQUESTED', missionId, {
          requestId: request.requestId,
          missionId,
          goalId: goal.goalId,
          level: mission.uncertainty.level,
          openQuestions: request.openQuestions,
        });
      }
      // Defensive: a resume without a wired gate cannot wait — treat it like a timeout (defaults).
      const outcome: ClarificationOutcome = gate !== undefined ? await gate.awaitAnswers(sessionId, request) : { kind: 'timeout' };
      if (outcome.kind === 'cancelled') return { mission, statements: [], cancelled: true };

      const source: 'user' | 'timeout' = outcome.kind === 'answered' ? 'user' : 'timeout';
      const merged = mergeClarificationAnswers(request, outcome.kind === 'answered' ? outcome.answers : {});

      let resolved: Mission = mission;
      let clarification: GoalClarification | undefined;
      if (merged.skipped.length > 0) {
        const r = await this.assumeAndState(sessionId, missionId, {
          ...mission,
          uncertainty: { level: mission.uncertainty.level, openQuestions: merged.skipped.map((q) => q.text) },
        });
        // Keep the real uncertainty on the copy; take only the mirrored acceptance criteria.
        resolved = { ...mission, acceptanceCriteria: r.mission.acceptanceCriteria };
        clarification = r.clarification;
      } else {
        resolved = { ...mission, uncertainty: { level: 'KNOWN', openQuestions: [] } };
      }

      const statements = [...merged.userStatements, ...flattenAssumptions(clarification)];
      await this.emit(sessionId, 'GOAL_CLARIFICATION_ANSWERED', missionId, {
        requestId: request.requestId,
        source,
        answers: merged.answered.map((a) => ({ questionId: a.questionId, question: a.question, answer: a.answer })),
        skippedQuestionIds: merged.skipped.map((q) => q.id),
        assumptions: statements,
      });
      return {
        mission: resolved,
        statements,
        cancelled: false,
        ...(clarification !== undefined ? { clarification } : {}),
      };
    }

    // Tier B1 (unchanged): only when the goal is under-specified (uncertainty ≥ INFERRED).
    if (mission.uncertainty.level === 'KNOWN') return { mission, statements: [], cancelled: false };
    const r = await this.assumeAndState(sessionId, missionId, mission);
    return {
      mission: r.mission,
      statements: flattenAssumptions(r.clarification),
      cancelled: false,
      ...(r.clarification !== undefined ? { clarification: r.clarification } : {}),
    };
  }

  /**
   * Tier B1: goal clarification by explicit assumption (option (ii)). When an advisor is wired,
   * make EXPLICIT assumptions instead of stopping to ask. The assumptions are mirrored into the
   * Mission's acceptanceCriteria (a mission-level copy — NEVER the Goal, MI-004) so planning has
   * a concrete target, and surfaced to the user via MISSION_ASSUMPTIONS_MADE (shown in the
   * dashboard like a commercial agent's "reasoning"). Fail-safe: on error, proceed unchanged.
   */
  private async assumeAndState(
    sessionId: string,
    missionId: string,
    mission: Mission,
  ): Promise<{ readonly mission: Mission; readonly clarification?: GoalClarification }> {
    if (this.deps.assumptionAdvisor === undefined) return { mission };
    try {
      const clarification = await this.deps.assumptionAdvisor.clarify(mission);
      const assumedCriteria: AcceptanceCriterion[] = clarification.assumptions.map((a, i) => ({
        criterionId: `${missionId}-assumed-${i + 1}`,
        description: a.acceptance,
        mandatory: false, // assumed, not user-stated — advisory acceptance
      }));
      const next: Mission = { ...mission, acceptanceCriteria: [...mission.acceptanceCriteria, ...assumedCriteria] };
      await this.emit(sessionId, 'MISSION_ASSUMPTIONS_MADE', missionId, {
        clarifiedGoal: clarification.clarifiedGoal,
        assumptions: clarification.assumptions,
      });
      return { mission: next, clarification };
    } catch {
      // Advisory LLM failure must not break the run (MI-001/MI-002): proceed without assumptions.
      return { mission };
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private assembleMission(parts: {
    missionId: string; goal: Goal; missionType: MissionType;
    complexity: Mission['complexity']; risk: Mission['risk']; contextScope: ContextScope;
    uncertainty: Mission['uncertainty'];
    planningMode: Mission['planningMode']; architectureRequirement: Mission['architectureRequirement'];
  }): Mission {
    const { missionId, goal, missionType, complexity, risk, contextScope, uncertainty, planningMode, architectureRequirement } = parts;
    return {
      missionId,
      goalId: goal.goalId,
      userGoal: goal.description,
      normalizedGoal: goal.description.trim(),
      missionType,
      complexity,
      risk,
      uncertainty,
      contextScope,
      planningMode,
      architectureRequirement,
      capabilityRequirements: this.deps.requiredCapabilities ?? [],
      modelRequirement: analyzeModelRequirement({
        // analyzeModelRequirement only reads complexity/type/architectureRequirement/contextScope.
        complexity, missionType, architectureRequirement, contextScope,
      } as Mission),
      researchRequired: missionType === 'RESEARCH',
      constraints: goal.constraints,
      acceptanceCriteria: goal.acceptanceCriteria,
      provenance: {
        provenanceId: this.deps.newId(),
        source: { kind: 'runtime', id: 'mission-intelligence' },
        inputs: [goal.goalId],
        reason: 'advisory mission analysis before planning (Phase 12)',
        at: this.deps.now(),
      },
      createdAt: this.deps.now(),
    };
  }

  private async emit(sessionId: string, type: EventType, missionId: string, payload: unknown): Promise<void> {
    if (this.quiet.has(sessionId)) return; // session-resume: already in the log (Req 4.7)
    const event: DomainEvent = {
      eventId: this.deps.newId(),
      sessionId,
      type,
      aggregate: { kind: 'mission', id: missionId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008)
    };
    try { await this.deps.events.append(event); }
    catch { /* audit append is best-effort — never break the advisory stage on a log write */ }
  }
}

// ── Pure derivations ──────────────────────────────────────────────────────────────

/**
 * Tier B2: flatten structured assumptions into plain statements so the orchestrator can thread
 * them into each TaskExecutorRequest (MissionStageDecision.assumptions). Empty list ⇒ the field is
 * omitted from the outcome (conditional spread) and prompts stay unchanged (fail-safe).
 */
function flattenAssumptions(clarification: GoalClarification | undefined): string[] {
  return clarification !== undefined
    ? clarification.assumptions.map((a) => a.assumption).filter((s) => s.trim().length > 0)
    : [];
}

function inferContextScope(type: MissionType, level: Mission['complexity']['level'], multiRepo: boolean): ContextScope {
  if (type === 'MULTI_REPOSITORY' || multiRepo) return 'MULTI_REPOSITORY';
  if (type === 'RESEARCH') return 'EXTERNAL_RESEARCH';
  if (level === 'SYSTEM' || type === 'PROJECT' || type === 'ARCHITECTURE' || type === 'MIGRATION') return 'REPOSITORY';
  if (level === 'HIGH') return 'MODULE';
  if (level === 'MEDIUM') return 'FILE';
  return 'TASK';
}

function deriveArchitectureRequirement(
  type: MissionType,
  level: Mission['complexity']['level'],
): Mission['architectureRequirement'] {
  if (level === 'SYSTEM' || type === 'PROJECT' || type === 'ARCHITECTURE') return 'REQUIRED';
  if (level === 'HIGH' || type === 'MIGRATION' || type === 'MULTI_REPOSITORY') return 'RECOMMENDED';
  return 'NOT_REQUIRED';
}

function emptyPreflight(missionId: string, at: string): PreflightReport {
  return { missionId, machine: [], workspace: [], aiModels: [], readiness: 0, blockers: [], warnings: [], createdAt: at };
}
