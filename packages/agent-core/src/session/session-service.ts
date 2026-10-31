/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SessionService (P1-S1) — DOMAIN_CONTRACTS §2.5, §24 (Session aggregate operations).
//
// Orchestrates the Session lifecycle over injected CONTRACTS (SessionRepository,
// EventLog, WorkspaceLockService) — agent-core never imports infrastructure (DC-002).
// The deterministic SessionStateMachine decides legality (SS-002/003/007); this
// service performs the effects in order and emits the audit events.
import type { Session } from '../domain/session.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { SessionRepository, EventLog } from '../repositories/index.js';
import type { WorkspaceLockService } from './workspace-lock.js';
import type { SessionState } from '../state-machine/states.js';
import {
  transitionSession,
  isSessionTerminal,
  type SessionEvent,
  type SessionTransitionContext,
} from './session-machine.js';

export class SessionError extends Error {
  public readonly code: 'INVALID_TRANSITION' | 'PREMATURE_COMPLETION' | 'NOT_FOUND' | 'TERMINAL';
  constructor(code: SessionError['code'], message?: string) {
    super(message ?? code);
    this.name = 'SessionError';
    this.code = code;
  }
}

/** Injected side-effect sources kept deterministic (no wall-clock / random in domain). */
export interface SessionServiceDeps {
  readonly sessions: SessionRepository;
  readonly events: EventLog;
  readonly lock: WorkspaceLockService;
  /** ISO timestamp source (injected for determinism). */
  readonly now: () => string;
  /** ULID/event-id source (injected for determinism). */
  readonly nextId: () => string;
}

export interface CreateSessionInput {
  readonly session: Session; // state MUST be 'CREATED'
  readonly hostname: string;
  readonly processId: number;
}

/** session-resume v1: hand an orphaned session over to the current runtime process. */
export interface AdoptSessionInput {
  readonly sessionId: string;
  /** A FRESH lock id (lock ids are primary keys; the dead process's lock is released). */
  readonly lockId: string;
  readonly hostname: string;
  readonly processId: number;
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /**
   * Create a session: acquire the workspace lock (SS-001), persist the session,
   * and emit SESSION_CREATED. If the lock is held, the LockService throws and no
   * session row is written.
   */
  async create(input: CreateSessionInput): Promise<Session> {
    const { session } = input;
    if (session.state !== 'CREATED') {
      throw new SessionError('INVALID_TRANSITION', 'new session must start in CREATED');
    }
    // SS-001: lock first. A held lock rejects here before any session is persisted.
    await this.deps.lock.acquire({
      lockId: session.lockId,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      hostname: input.hostname,
      processId: input.processId,
      at: this.deps.now(),
    });
    await this.deps.sessions.create(session);
    await this.emit(session.sessionId, 'SESSION_CREATED', { state: session.state });
    return session;
  }

  /**
   * Apply a lifecycle event. Validates via the SessionStateMachine (SS-002/007),
   * persists the new state, and emits SESSION_STATE_CHANGED. Terminal transitions
   * (COMPLETED/ABORTED) also release the workspace lock.
   */
  async transition(
    sessionId: string,
    event: SessionEvent,
    ctx: SessionTransitionContext = {},
  ): Promise<Session> {
    const current = await this.deps.sessions.getById(sessionId);
    if (!current) {
      throw new SessionError('NOT_FOUND', sessionId);
    }
    const result = transitionSession(current.state, event, ctx);
    if (!result.ok) {
      const code = result.code === 'GUARD_FAILED' ? 'INVALID_TRANSITION' : result.code;
      throw new SessionError(
        code === 'TERMINAL_STATE' ? 'TERMINAL' : 'INVALID_TRANSITION',
        result.reason,
      );
    }
    return this.applyState(current, result.next, event);
  }

  /**
   * Complete a session (RUNNING --ALL_TASKS_TERMINAL--> COMPLETED). SS-003: rejects
   * if not all tasks are terminal. Caller supplies the terminal check result.
   */
  async complete(sessionId: string, allTasksTerminal: boolean): Promise<Session> {
    const current = await this.deps.sessions.getById(sessionId);
    if (!current) {
      throw new SessionError('NOT_FOUND', sessionId);
    }
    const result = transitionSession(current.state, 'ALL_TASKS_TERMINAL', { allTasksTerminal });
    if (!result.ok) {
      // SS-003: guard failure here means non-terminal tasks remain.
      throw new SessionError('PREMATURE_COMPLETION', result.reason);
    }
    const updated = await this.applyState(current, result.next, 'ALL_TASKS_TERMINAL');
    return updated;
  }

  /**
   * session-resume v1: adopt a non-terminal session left behind by a dead runtime process.
   * Acquires a NEW workspace lock for it (SS-001 — throws LockError('LOCK_HELD') unchanged when a
   * live session holds the workspace, so the caller can leave everything alone), records the new
   * owner in the session row, and emits SESSION_ADOPTED. The session STATE is not changed — no
   * transition is added to the state machine (SS-002).
   */
  async adopt(input: AdoptSessionInput): Promise<Session> {
    const current = await this.deps.sessions.getById(input.sessionId);
    if (!current) {
      throw new SessionError('NOT_FOUND', input.sessionId);
    }
    if (isSessionTerminal(current.state)) {
      throw new SessionError('TERMINAL', `session is terminal: ${current.state}`);
    }
    await this.deps.lock.acquire({
      lockId: input.lockId,
      workspaceId: current.workspaceId,
      sessionId: current.sessionId,
      hostname: input.hostname,
      processId: input.processId,
      at: this.deps.now(),
    });
    const updated: Session = {
      ...current,
      lockId: input.lockId,
      metadata: { ...current.metadata, hostname: input.hostname, processId: input.processId },
      updatedAt: this.deps.now(),
    };
    await this.deps.sessions.update(updated);
    await this.emit(current.sessionId, 'SESSION_ADOPTED', {
      previousProcessId: current.metadata.processId,
      processId: input.processId,
      lockId: input.lockId,
    });
    return updated;
  }

  // ---- internals ----

  private async applyState(
    current: Session,
    next: SessionState,
    event: SessionEvent,
  ): Promise<Session> {
    const updated: Session = { ...current, state: next, updatedAt: this.deps.now() };
    await this.deps.sessions.update(updated);

    const eventType: EventType =
      next === 'COMPLETED'
        ? 'SESSION_COMPLETED'
        : next === 'ABORTED'
          ? 'SESSION_ABORTED'
          : 'SESSION_STATE_CHANGED';
    await this.emit(current.sessionId, eventType, {
      from: current.state,
      to: next,
      event,
    });

    // Terminal transitions release the workspace lock (frees SS-001 for the workspace).
    if (isSessionTerminal(next)) {
      await this.deps.lock.release(current.lockId, current.sessionId, this.deps.now());
    }
    return updated;
  }

  private async emit(sessionId: string, type: EventType, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId,
      type,
      aggregate: { kind: 'session', id: sessionId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008); value ignored
    };
    await this.deps.events.append(event);
  }
}
