// Session — DOMAIN_CONTRACTS §2. Runtime lifecycle for one workspace session.
import type { SessionState } from '../state-machine/states.js';

export interface SessionOllamaModels {
  readonly planner: string;
  readonly critic: string;
  readonly executor: string;
  readonly analyzer: string;
}

export interface SessionMetadata {
  readonly hostname: string;
  readonly processId: number;
  readonly ollamaEndpoint: string;
  readonly ollamaModels: SessionOllamaModels;
}

export interface Session {
  readonly sessionId: string; // ULID
  readonly workspaceId: string; // hash of canonical root
  readonly workspaceRoot: string; // canonical absolute path

  readonly goalId: string; // reference
  readonly graphVersion: number; // current

  readonly state: SessionState;
  readonly createdAt: string; // ISO 8601
  readonly updatedAt: string;

  readonly runtimeVersion: string;
  readonly schemaVersion: number;

  readonly budgetId: string; // reference
  readonly lockId: string; // reference

  readonly metadata: SessionMetadata;
}
