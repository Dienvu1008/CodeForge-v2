// P3-TR1 — ToolRegistry (TG-006/008/009).
import { describe, it, expect } from 'vitest';
import {
  ToolRegistry,
  ToolRegistryError,
  createDefaultRegistry,
  FILESYSTEM_TOOL_DEFINITIONS,
  type ToolDefinition,
} from '@codeforge/agent-core';

const sampleDef: ToolDefinition = {
  toolName:            'read_file',
  version:             '1.0',
  description:         'Read a file',
  riskClass:           'READ_ONLY',
  argsSchema:          { path: { type: 'string', required: true } },
  idempotencyStrategy: 'none',
};

describe('ToolRegistry — registration', () => {
  it('registers a tool and retrieves it by name', () => {
    const reg = new ToolRegistry();
    reg.register(sampleDef);
    expect(reg.get('read_file')?.toolName).toBe('read_file');
    expect(reg.has('read_file')).toBe(true);
    expect(reg.size).toBe(1);
  });

  it('throws ALREADY_REGISTERED on duplicate register()', () => {
    const reg = new ToolRegistry();
    reg.register(sampleDef);
    expect(() => reg.register(sampleDef)).toThrow(ToolRegistryError);
    const err = (() => { try { reg.register(sampleDef); } catch (e) { return e; } })() as ToolRegistryError;
    expect(err.code).toBe('ALREADY_REGISTERED');
  });

  it('registerOrReplace silently overwrites', () => {
    const reg = new ToolRegistry();
    reg.register(sampleDef);
    const updated = { ...sampleDef, version: '2.0' };
    expect(() => reg.registerOrReplace(updated)).not.toThrow();
    expect(reg.get('read_file')?.version).toBe('2.0');
  });

  it('get() returns null for unknown tool', () => {
    const reg = new ToolRegistry();
    expect(reg.get('unknown')).toBeNull();
  });

  it('getOrThrow() throws NOT_FOUND for unknown tool', () => {
    const reg = new ToolRegistry();
    const err = (() => { try { reg.getOrThrow('x'); } catch (e) { return e; } })() as ToolRegistryError;
    expect(err.code).toBe('NOT_FOUND');
  });

  it('list() returns sorted tool names', () => {
    const reg = new ToolRegistry();
    reg.register({ ...sampleDef, toolName: 'write_file' });
    reg.register(sampleDef);
    expect(reg.list()).toEqual(['read_file', 'write_file']);
  });
});

describe('ToolRegistry.toSchemas — TG-009 schema map', () => {
  it('builds schemas record for ToolGateway', () => {
    const reg = new ToolRegistry();
    reg.register(sampleDef);
    const schemas = reg.toSchemas();
    expect(schemas['read_file']).toBeDefined();
    expect(schemas['read_file']?.['path']).toMatchObject({ type: 'string', required: true });
  });
});

describe('createDefaultRegistry — built-in tools', () => {
  it('includes all filesystem + git tools', () => {
    const reg = createDefaultRegistry();
    expect(reg.has('read_file')).toBe(true);
    expect(reg.has('write_file')).toBe(true);
    expect(reg.has('list_dir')).toBe(true);
    expect(reg.has('delete_file')).toBe(true);
    expect(reg.has('git_status')).toBe(true);
    expect(reg.has('git_diff')).toBe(true);
    expect(reg.has('git_add')).toBe(true);
    expect(reg.has('git_commit')).toBe(true);
    expect(reg.has('run_command')).toBe(true);
    expect(reg.size).toBe(FILESYSTEM_TOOL_DEFINITIONS.length);
  });

  it('read_file is READ_ONLY (no approval needed)', () => {
    const def = createDefaultRegistry().getOrThrow('read_file');
    expect(def.riskClass).toBe('READ_ONLY');
  });

  it('delete_file is DESTRUCTIVE (approval required)', () => {
    const def = createDefaultRegistry().getOrThrow('delete_file');
    expect(def.riskClass).toBe('DESTRUCTIVE');
  });

  it('write_file has content-hash idempotency strategy (TG-006)', () => {
    const def = createDefaultRegistry().getOrThrow('write_file');
    expect(def.idempotencyStrategy).toBe('content-hash');
  });

  it('run_command is SYSTEM risk class', () => {
    const def = createDefaultRegistry().getOrThrow('run_command');
    expect(def.riskClass).toBe('SYSTEM');
  });

  it('every tool has a non-empty description (TG-008 provenance aid)', () => {
    const reg = createDefaultRegistry();
    for (const name of reg.list()) {
      const def = reg.getOrThrow(name);
      expect(def.description.length, `${name} missing description`).toBeGreaterThan(0);
    }
  });

  it('every tool has an argsSchema (TG-009)', () => {
    const reg = createDefaultRegistry();
    for (const name of reg.list()) {
      const def = reg.getOrThrow(name);
      expect(def.argsSchema, `${name} missing argsSchema`).toBeDefined();
    }
  });
});
