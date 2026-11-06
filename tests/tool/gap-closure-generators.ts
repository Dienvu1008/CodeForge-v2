/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared seeded generators for the kernel-gap-closure specs (tests/shell, tests/tool,
// tests/workspace, tests/execution, tests/security). Same mulberry32 helper style as
// tests/observability-server/http-security.spec.ts; kept here because tests/tsconfig.json
// does not include tests/mission/**. Test-only; no production imports.

export type Rng = () => number;

/** Deterministic 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max], both inclusive. */
export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function bool(rng: Rng, pTrue = 0.5): boolean {
  return rng() < pTrue;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[int(rng, 0, items.length - 1)] as T;
}

/** Run `body` `runs` times; on failure re-throw with iteration + seed (reproducible counterexample). */
export function forAll(seed: number, runs: number, body: (rng: Rng, iteration: number) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

/** Async twin of `forAll`. */
export async function forAllAsync(
  seed: number,
  runs: number,
  body: (rng: Rng, iteration: number) => Promise<void>,
): Promise<void> {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      await body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

// ── string builders ──────────────────────────────────────────────────────────────────────────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Random string of `length` characters drawn from `alphabet`. */
export function randomString(rng: Rng, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet.charAt(int(rng, 0, alphabet.length - 1));
  return out;
}

/** One base64-style line (default 64 characters, like PEM). */
export function base64Line(rng: Rng, length = 64): string {
  return randomString(rng, BASE64_ALPHABET, length);
}

/** `lines` base64-style lines (each 16..76 chars unless `width` given). Returns the individual lines. */
export function base64Lines(rng: Rng, lines: number, width?: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(base64Line(rng, width ?? int(rng, 16, 76)));
  return out;
}

/** Uppercase word of 1..maxLen characters (A-Z). */
export function upperWord(rng: Rng, maxLen = 8): string {
  return randomString(rng, UPPER, int(rng, 1, maxLen));
}

/** Lowercase alphanumeric path segment of 1..maxLen characters, never `.` or `..`. */
export function pathSegment(rng: Rng, maxLen = 8): string {
  return randomString(rng, ALNUM, int(rng, 1, maxLen));
}

/** Relative path of `depth` segments (default 0..4 segments, at least 1) joined by `sep`. */
export function pathOf(rng: Rng, sep: '/' | '\\' = '/', depth: number = int(rng, 1, 4)): string {
  const parts: string[] = [];
  for (let i = 0; i < depth; i++) parts.push(pathSegment(rng));
  return parts.join(sep);
}

/** Argument list of `count` simple tokens (no whitespace, no shell metacharacters, not path-like). */
export function plainArgs(rng: Rng, count: number = int(rng, 0, 5)): string[] {
  const flags = ['-a', '-v', '--force', '--verbose', '-n', '--quiet'];
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(bool(rng, 0.4) ? pick(rng, flags) : pathSegment(rng));
  return out;
}

// ── decorators ───────────────────────────────────────────────────────────────────────────────

/** Randomly upper/lower-cases each character. */
export function randomCase(rng: Rng, text: string): string {
  let out = '';
  for (const ch of text) out += bool(rng) ? ch.toUpperCase() : ch.toLowerCase();
  return out;
}

/** Whitespace run of 1..max characters (spaces and tabs). */
export function whitespace(rng: Rng, max = 3): string {
  return randomString(rng, ' \t', int(rng, 1, max));
}

/** Wraps `text` in 0..max whitespace characters on each side. */
export function padWhitespace(rng: Rng, text: string, max = 3): string {
  const lead = bool(rng) ? whitespace(rng, max) : '';
  const trail = bool(rng) ? whitespace(rng, max) : '';
  return `${lead}${text}${trail}`;
}

/** Escapes newlines the way JSON.stringify does inside a string value (`\n` -> backslash-n). */
export function escapeNewlines(text: string): string {
  return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}
