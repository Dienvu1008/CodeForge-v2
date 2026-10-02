// P4-IK1 — IdempotencyEngine: TG-006 content-hash deduplication.
import { describe, it, expect, beforeEach } from 'vitest';
import { IdempotencyEngine } from '@codeforge/agent-core';
import type { ToolDefinition } from '@codeforge/agent-core';

// ── helpers ───────────────────────────────────────────────────────────────────

function def(
  toolName: string,
  idempotencyStrategy: ToolDefinition['idempotencyStrategy'],
  riskClass: ToolDefinition['riskClass'] = 'MODIFY_WORKSPACE',
): ToolDefinition {
  return {
    toolName,
    version: '1.0',
    description: '',
    riskClass,
    argsSchema: {},
    idempotencyStrategy,
  };
}

// ── IdempotencyEngine ─────────────────────────────────────────────────────────

describe('IdempotencyEngine (P4-IK1)', () => {
  let engine: IdempotencyEngine;

  beforeEach(() => {
    engine = new IdempotencyEngine();
  });

  // ── strategy: none ────────────────────────────────────────────────────────

  describe('strategy: none', () => {
    it('returns idempotencyKey=undefined, isDuplicate=false', () => {
      const r = engine.check(def('read_file', 'none', 'READ_ONLY'), { path: 'foo.ts' });
      expect(r.idempotencyKey).toBeUndefined();
      expect(r.isDuplicate).toBe(false);
    });

    it('never reports duplicate even after markExecuted(undefined)', () => {
      const r1 = engine.check(def('read_file', 'none'), { path: 'foo.ts' });
      engine.markExecuted(r1.idempotencyKey); // no-op
      const r2 = engine.check(def('read_file', 'none'), { path: 'foo.ts' });
      expect(r2.isDuplicate).toBe(false);
    });
  });

  // ── strategy: content-hash ────────────────────────────────────────────────

  describe('strategy: content-hash', () => {
    it('returns a non-empty idempotencyKey', () => {
      const r = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      expect(typeof r.idempotencyKey).toBe('string');
      expect(r.idempotencyKey!.length).toBeGreaterThan(0);
    });

    it('same toolName+args produces same key (deterministic)', () => {
      const r1 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      const r2 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      expect(r1.idempotencyKey).toBe(r2.idempotencyKey);
    });

    it('different args produce different keys', () => {
      const r1 = engine.check(def('write_file', 'content-hash'), { path: 'a.ts', content: 'x' });
      const r2 = engine.check(def('write_file', 'content-hash'), { path: 'b.ts', content: 'x' });
      expect(r1.idempotencyKey).not.toBe(r2.idempotencyKey);
    });

    it('different toolNames with same args produce different keys', () => {
      const r1 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts' });
      const r2 = engine.check(def('delete_file', 'content-hash', 'DESTRUCTIVE'), { path: 'x.ts' });
      expect(r1.idempotencyKey).not.toBe(r2.idempotencyKey);
    });

    it('isDuplicate=false before markExecuted', () => {
      const r = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      expect(r.isDuplicate).toBe(false);
    });

    it('isDuplicate=true after markExecuted with same key', () => {
      const r1 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      engine.markExecuted(r1.idempotencyKey);
      const r2 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      expect(r2.isDuplicate).toBe(true);
    });

    it('isDuplicate=false for different args even after marking another key', () => {
      const r1 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      engine.markExecuted(r1.idempotencyKey);
      const r2 = engine.check(def('write_file', 'content-hash'), { path: 'y.ts', content: 'b' });
      expect(r2.isDuplicate).toBe(false);
    });

    it('key is stable regardless of object key order (canonical JSON)', () => {
      // { path, content } vs { content, path } — should hash the same.
      const r1 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      const r2 = engine.check(def('write_file', 'content-hash'), { content: 'a', path: 'x.ts' });
      expect(r1.idempotencyKey).toBe(r2.idempotencyKey);
    });

    it('array args: order preserved (not sorted)', () => {
      // git_add paths array — order matters for git
      const r1 = engine.check(def('git_add', 'content-hash'), { paths: ['a.ts', 'b.ts'] });
      const r2 = engine.check(def('git_add', 'content-hash'), { paths: ['b.ts', 'a.ts'] });
      expect(r1.idempotencyKey).not.toBe(r2.idempotencyKey);
    });
  });

  // ── strategy: custom ─────────────────────────────────────────────────────

  describe('strategy: custom', () => {
    it('computes a key (falls back to content-hash logic)', () => {
      const r = engine.check(def('run_command', 'custom', 'SYSTEM'), { command: 'npm', args: ['test'] });
      expect(r.idempotencyKey).toBeDefined();
      expect(r.isDuplicate).toBe(false);
    });

    it('detects duplicate for custom strategy too', () => {
      const r1 = engine.check(def('run_command', 'custom', 'SYSTEM'), { command: 'npm', args: ['test'] });
      engine.markExecuted(r1.idempotencyKey);
      const r2 = engine.check(def('run_command', 'custom', 'SYSTEM'), { command: 'npm', args: ['test'] });
      expect(r2.isDuplicate).toBe(true);
    });
  });

  // ── reset ────────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('clears all seen keys — duplicate becomes false again', () => {
      const r1 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      engine.markExecuted(r1.idempotencyKey);
      engine.reset();
      const r2 = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      expect(r2.isDuplicate).toBe(false);
    });
  });

  // ── size ─────────────────────────────────────────────────────────────────

  describe('size', () => {
    it('starts at 0', () => {
      expect(engine.size).toBe(0);
    });

    it('increments after markExecuted with a key', () => {
      const r = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      engine.markExecuted(r.idempotencyKey);
      expect(engine.size).toBe(1);
    });

    it('does not increment for undefined (strategy=none)', () => {
      const r = engine.check(def('read_file', 'none', 'READ_ONLY'), { path: 'x.ts' });
      engine.markExecuted(r.idempotencyKey);
      expect(engine.size).toBe(0);
    });

    it('does not double-count same key', () => {
      const r = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      engine.markExecuted(r.idempotencyKey);
      engine.markExecuted(r.idempotencyKey); // duplicate markExecuted
      expect(engine.size).toBe(1);
    });

    it('resets to 0 after reset()', () => {
      const r = engine.check(def('write_file', 'content-hash'), { path: 'x.ts', content: 'a' });
      engine.markExecuted(r.idempotencyKey);
      engine.reset();
      expect(engine.size).toBe(0);
    });
  });

  // ── TaskExecutor integration: wire check → markExecuted ──────────────────

  describe('lifecycle pattern (check → execute → markExecuted)', () => {
    it('full lifecycle: two identical calls — second is duplicate', () => {
      const toolDef = def('write_file', 'content-hash');
      const args    = { path: 'index.ts', content: 'export {};\n' };

      // First call: not duplicate → execute → mark
      const r1 = engine.check(toolDef, args);
      expect(r1.isDuplicate).toBe(false);
      engine.markExecuted(r1.idempotencyKey);

      // Second call: duplicate → skip
      const r2 = engine.check(toolDef, args);
      expect(r2.isDuplicate).toBe(true);
    });

    it('two different MODIFY calls are both executed', () => {
      const toolDef = def('write_file', 'content-hash');

      const r1 = engine.check(toolDef, { path: 'a.ts', content: 'a' });
      expect(r1.isDuplicate).toBe(false);
      engine.markExecuted(r1.idempotencyKey);

      const r2 = engine.check(toolDef, { path: 'b.ts', content: 'b' });
      expect(r2.isDuplicate).toBe(false);
      engine.markExecuted(r2.idempotencyKey);

      expect(engine.size).toBe(2);
    });
  });
});
