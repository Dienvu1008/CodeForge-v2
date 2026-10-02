// ToolRegistry — P3-TR1. Coding Agent Architecture §21/§22.
//
// Central registry of all available tools. Each tool has:
//   - a unique name + version,
//   - a risk class (determines ToolPolicy action),
//   - a JSON argument schema (TG-009: validated before execution),
//   - a description for model prompting.
//
// TG-006: tools should declare an idempotency key strategy so duplicate calls
//         can be detected (field stored on ToolCall.idempotencyKey).
// TG-008: ToolRegistry tracks which model/context proposed each call — the
//         provenance is built by the caller (TaskExecutor) from the snapshot.
//
// Pure + deterministic: registry is an in-memory map; same register calls →
// same state. No I/O, no LLM.
import type { RiskClass } from '../domain/tool-call.js';
import type { OutputSchema } from '../security/structured-output-validator.js';

// ── ToolDefinition ────────────────────────────────────────────────────────────

export interface ToolDefinition {
  /** Stable tool name (e.g. 'read_file'). Must be unique in the registry. */
  readonly toolName:    string;
  readonly version:     string;
  readonly description: string;
  readonly riskClass:   RiskClass;
  /**
   * JSON schema for the `arguments` object passed in a ToolCall.
   * ToolGateway.request() validates against this schema (TG-009).
   */
  readonly argsSchema:  OutputSchema;
  /**
   * Idempotency key strategy (TG-006).
   * 'none'            → no idempotency key (fire-and-forget, e.g. read_file).
   * 'content-hash'    → key derived from arguments hash (prevents duplicate writes).
   * 'custom'          → caller supplies idempotencyKey explicitly.
   */
  readonly idempotencyStrategy: 'none' | 'content-hash' | 'custom';
}

// ── ToolRegistryError ─────────────────────────────────────────────────────────

export class ToolRegistryError extends Error {
  public readonly code: 'ALREADY_REGISTERED' | 'NOT_FOUND';
  constructor(code: ToolRegistryError['code'], message?: string) {
    super(message ?? code);
    this.name = 'ToolRegistryError';
    this.code = code;
  }
}

// ── ToolRegistry ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly _tools = new Map<string, ToolDefinition>();

  /**
   * Register a tool definition.
   * Throws `ALREADY_REGISTERED` if a tool with the same name already exists.
   * Use `registerOrReplace` to allow overwriting (e.g. for testing).
   */
  register(def: ToolDefinition): void {
    if (this._tools.has(def.toolName)) {
      throw new ToolRegistryError(
        'ALREADY_REGISTERED',
        `tool "${def.toolName}" is already registered`,
      );
    }
    this._tools.set(def.toolName, def);
  }

  /** Register or silently replace. */
  registerOrReplace(def: ToolDefinition): void {
    this._tools.set(def.toolName, def);
  }

  /** Get a tool definition by name. Returns null if not found. */
  get(toolName: string): ToolDefinition | null {
    return this._tools.get(toolName) ?? null;
  }

  /** Get or throw NOT_FOUND. */
  getOrThrow(toolName: string): ToolDefinition {
    const def = this._tools.get(toolName);
    if (def === undefined) {
      throw new ToolRegistryError('NOT_FOUND', `tool "${toolName}" not registered`);
    }
    return def;
  }

  /** All registered tool names (sorted for determinism). */
  list(): readonly string[] {
    return [...this._tools.keys()].sort();
  }

  /** True if a tool is registered. */
  has(toolName: string): boolean {
    return this._tools.has(toolName);
  }

  /** Total number of registered tools. */
  get size(): number {
    return this._tools.size;
  }

  /**
   * Build the schemas map required by ToolGateway (schemas: Record<name, OutputSchema>).
   * Returns a plain object so it can be spread into ToolGatewayDeps.
   */
  toSchemas(): Readonly<Record<string, OutputSchema>> {
    const schemas: Record<string, OutputSchema> = {};
    for (const [name, def] of this._tools) {
      schemas[name] = def.argsSchema;
    }
    return schemas;
  }
}

// ── Built-in tool definitions ─────────────────────────────────────────────────

/** Standard tool definitions for Phase 3 filesystem + git tools. */
export const FILESYSTEM_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    toolName:             'read_file',
    version:              '1.0',
    description:          'Read the content of a file at a given workspace-relative path.',
    riskClass:            'READ_ONLY',
    argsSchema:           { path: { type: 'string', required: true } },
    idempotencyStrategy:  'none',
  },
  {
    toolName:             'write_file',
    version:              '1.0',
    description:          'Write (create or overwrite) a file at a workspace-relative path.',
    riskClass:            'MODIFY_WORKSPACE',
    argsSchema:           {
      path:    { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    idempotencyStrategy:  'content-hash',
  },
  {
    toolName:             'list_dir',
    version:              '1.0',
    description:          'List files and directories at a workspace-relative path.',
    riskClass:            'READ_ONLY',
    argsSchema:           { path: { type: 'string', required: true } },
    idempotencyStrategy:  'none',
  },
  {
    toolName:             'delete_file',
    version:              '1.0',
    description:          'Delete a file at a workspace-relative path.',
    riskClass:            'DESTRUCTIVE',
    argsSchema:           { path: { type: 'string', required: true } },
    idempotencyStrategy:  'content-hash',
  },
  {
    toolName:             'git_status',
    version:              '1.0',
    description:          'Show git status of the workspace.',
    riskClass:            'READ_ONLY',
    argsSchema:           {},
    idempotencyStrategy:  'none',
  },
  {
    toolName:             'git_diff',
    version:              '1.0',
    description:          'Show git diff for the workspace or a specific file.',
    riskClass:            'READ_ONLY',
    argsSchema:           { path: { type: 'string' } },
    idempotencyStrategy:  'none',
  },
  {
    toolName:             'git_add',
    version:              '1.0',
    description:          'Stage files for git commit.',
    riskClass:            'MODIFY_WORKSPACE',
    argsSchema:           { paths: { type: 'array', required: true } },
    idempotencyStrategy:  'content-hash',
  },
  {
    toolName:             'git_commit',
    version:              '1.0',
    description:          'Create a git commit with the staged changes.',
    riskClass:            'MODIFY_WORKSPACE',
    argsSchema:           { message: { type: 'string', required: true } },
    idempotencyStrategy:  'content-hash',
  },
  {
    toolName:             'git_log',
    version:              '1.0',
    description:          'Show recent git commits (one-line format).',
    riskClass:            'READ_ONLY',
    argsSchema:           { n: { type: 'number', min: 1, max: 100 } },
    idempotencyStrategy:  'none',
  },
  {
    toolName:             'run_command',
    version:              '1.0',
    description:          'Run an allowlisted shell command (no shell interpolation).',
    riskClass:            'SYSTEM',
    argsSchema:           {
      command:    { type: 'string', required: true },
      args:       { type: 'array' },
      timeoutMs:  { type: 'number', min: 100, max: 300_000 },
    },
    idempotencyStrategy:  'custom',
  },
];

/** Create a ToolRegistry pre-loaded with standard filesystem + git tools. */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const def of FILESYSTEM_TOOL_DEFINITIONS) {
    registry.register(def);
  }
  return registry;
}
