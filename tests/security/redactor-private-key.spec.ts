/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-gap-closure R1 â€” private-key redaction (design D-F / C10, Properties 1 and 2).
//
// TEST-FIRST: the bare PKCS#8 header `-----BEGIN PRIVATE KEY-----` is not matched by the current
// pattern `-----BEGIN [A-Z ]+PRIVATE KEY-----` (it requires at least one type word plus a space),
// so the bare cases fail until task 2.1 fixes the redactor. Typed headers and public material
// already pass.
//
// Reference checks are plain `includes` / equality, independent of the production regex.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
import { describe, it, expect } from 'vitest';
import { redact, redactJson, REDACTION_RULES } from '@codeforge/infrastructure';
import {
  base64Lines,
  bool,
  forAll,
  int,
  pick,
  upperWord,
  type Rng,
} from '../tool/gap-closure-generators.js';

const PLACEHOLDER = '[REDACTED]';

// Prefix / suffix texts chosen so no other redaction rule can fire on them
// (no "token", "secret", "password", "Bearer", "AKIA", URL schemes).
const PREFIXES: readonly string[] = [
  '',
  'before ',
  'key file contents:\n',
  '{"msg":"',
  '2026-01-01T00:00:00Z INFO loaded ',
];
const SUFFIXES: readonly string[] = ['', ' after', '\nend of file', '"}', ' done\n'];

interface PemParts {
  readonly begin: string;
  readonly end: string;
  readonly lines: readonly string[];
}

/** 0..4 uppercase type words (NONE = bare PKCS#8) and an optional ` BLOCK` tail (PGP style). */
function privateKeyParts(rng: Rng): PemParts {
  const wordCount = int(rng, 0, 4);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(upperWord(rng, 8));
  const head = `${words.map((w) => `${w} `).join('')}PRIVATE KEY${bool(rng, 0.15) ? ' BLOCK' : ''}`;
  return {
    begin: `-----BEGIN ${head}-----`,
    end: `-----END ${head}-----`,
    lines: base64Lines(rng, int(rng, 1, 200)),
  };
}

type Layout = 'plain' | 'json-escaped' | 'log-line';

function render(parts: PemParts, layout: Layout): { text: string; body: string; block: string } {
  const sep = layout === 'json-escaped' ? '\\n' : '\n';
  const body = parts.lines.join(sep);
  const block = `${parts.begin}${sep}${body}${sep}${parts.end}`;
  return { text: block, body, block };
}

describe('redactor private-key rule (R1)', () => {
  // Feature: kernel-gap-closure, Property 1: Private-key blocks are fully redacted
  describe('Property 1: Private-key blocks are fully redacted', () => {
    for (const layout of ['plain', 'json-escaped', 'log-line'] as const) {
      it(`redact() removes body and every body line, keeps prefix and suffix (${layout})`, () => {
        forAll(0x1a2b3c, 120, (rng, i) => {
          const parts = privateKeyParts(rng);
          const { block, body } = render(parts, layout);
          let prefix = pick(rng, PREFIXES);
          let suffix = pick(rng, SUFFIXES);
          if (layout === 'log-line') {
            prefix = `2026-02-03T04:05:06Z level=warn msg=dump ${prefix.replace(/\n/g, ' ')}`;
            suffix = ` ${suffix.replace(/\n/g, ' ')} trace=${i}`;
          }
          const out = redact(`${prefix}${block}${suffix}`);
          expect(out, 'placeholder present').toContain(PLACEHOLDER);
          expect(out, 'body survived').not.toContain(body);
          for (const line of parts.lines) expect(out, `body line survived: ${line}`).not.toContain(line);
          expect(out, 'header survived').not.toContain(parts.begin);
          expect(out, 'footer survived').not.toContain(parts.end);
          expect(out).toBe(`${prefix}${PLACEHOLDER}${suffix}`);
        });
      });
    }

    it('redactJson() removes the block from nested string values', () => {
      forAll(0x4d5e6f, 100, (rng) => {
        const parts = privateKeyParts(rng);
        const { block, body } = render(parts, bool(rng) ? 'plain' : 'json-escaped');
        const prefix = pick(rng, PREFIXES);
        const suffix = pick(rng, SUFFIXES);
        const text = `${prefix}${block}${suffix}`;
        const out = redactJson({ a: { msg: text }, list: [1, text, null], n: 7 }) as {
          a: { msg: string };
          list: [number, string, null];
          n: number;
        };
        expect(out.n).toBe(7);
        expect(out.a.msg).toBe(`${prefix}${PLACEHOLDER}${suffix}`);
        expect(out.list[1]).toBe(`${prefix}${PLACEHOLDER}${suffix}`);
        const serialised = JSON.stringify(out);
        expect(serialised).not.toContain(body);
        for (const line of parts.lines) expect(serialised).not.toContain(line);
      });
    });
  });

  // Feature: kernel-gap-closure, Property 2: Public material is not redacted
  describe('Property 2: Public material is not redacted', () => {
    it('PUBLIC KEY and CERTIFICATE blocks are returned unchanged', () => {
      forAll(0x7a8b9c, 120, (rng) => {
        const label = pick(rng, ['PUBLIC KEY', 'CERTIFICATE', 'RSA PUBLIC KEY', 'X509 CRL'] as const);
        const sep = bool(rng) ? '\n' : '\\n';
        const lines = base64Lines(rng, int(rng, 1, 200));
        const block = `-----BEGIN ${label}-----${sep}${lines.join(sep)}${sep}-----END ${label}-----`;
        const input = `${pick(rng, PREFIXES)}${block}${pick(rng, SUFFIXES)}`;
        expect(redact(input)).toBe(input);
        expect(redactJson({ v: input })).toEqual({ v: input });
      });
    });
  });

  describe('examples', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabcDEF123+/abcDEF123+/abcDEF123+/==';
    const heads: ReadonlyArray<readonly [string, string]> = [
      ['bare PKCS#8', 'PRIVATE KEY'],
      ['RSA', 'RSA PRIVATE KEY'],
      ['EC', 'EC PRIVATE KEY'],
      ['DSA', 'DSA PRIVATE KEY'],
      ['OPENSSH', 'OPENSSH PRIVATE KEY'],
      ['ENCRYPTED', 'ENCRYPTED PRIVATE KEY'],
      ['PGP block', 'PGP PRIVATE KEY BLOCK'],
    ];
    for (const [name, head] of heads) {
      it(`${name}: whole block becomes the placeholder`, () => {
        const block = `-----BEGIN ${head}-----\n${body}\n-----END ${head}-----`;
        expect(redact(block)).toBe(PLACEHOLDER);
        expect(redact(`x ${block} y`)).toBe(`x ${PLACEHOLDER} y`);
        expect(redact(`x ${block} y`)).not.toContain('MIIEvQ');
      });
    }

    it('200 000 characters of repeated bare headers with no footer return within 1 000 ms', () => {
      const unit = '-----BEGIN PRIVATE KEY-----\n';
      const input = unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000);
      const t0 = performance.now();
      const out = redact(input);
      const elapsed = performance.now() - t0;
      expect(out.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(1000);
    });

    it('200 000 characters of repeated typed headers with no footer return within 1 000 ms', () => {
      const unit = '-----BEGIN RSA PRIVATE KEY-----\n';
      const input = unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000);
      const t0 = performance.now();
      const out = redact(input);
      const elapsed = performance.now() - t0;
      expect(out.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(1000);
    });

    it('REDACTION_RULES still contains the private-key rule at its current index', () => {
      // Captured before the fix; the fix must not rename, add, remove or reorder rules.
      expect(REDACTION_RULES.map((r) => r.name)).toEqual([
        'jwt',
        'bearer',
        'private-key',
        'aws-access-key',
        'generic-secret',
        'connection-string',
      ]);
      expect(REDACTION_RULES.findIndex((r) => r.name === 'private-key')).toBe(2);
      expect(REDACTION_RULES[2]?.replacement).toBe(PLACEHOLDER);
    });
  });
});
