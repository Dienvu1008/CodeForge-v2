/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-gap-closure — Risk_Classifier (TG-011, TG-012, TG-013). Design C3.
//
// Pure: no I/O, no clock, no random source, no environment access (Requirement 10.1).
// Replaces the body of TaskExecutor.resolveRiskClass. The tool-name table is unchanged for tools
// not covered by the new rules; `run_command` is classified by command, and mutations of a test
// file that existed when the goal started are escalated to DESTRUCTIVE (human approval).

import type { RiskClass } from '../domain/tool-call.js';
import {
  classifyShellInvocation,
  extractShellArguments,
  normalizeInvocation,
} from './shell-classifier.js';

/** Port: the Test_Like_Paths that existed when the current goal started. Synchronous, no I/O. */
export interface TestBaseline {
  isBaselineTest(relpath: string): boolean;
}

export interface RiskContext {
  /** When absent, behaves exactly like an empty baseline. */
  readonly testBaseline?: TestBaseline;
}

/** Shell commands whose file arguments are overwritten, created or moved (beyond DESTRUCTIVE ones). */
const TEST_MUTATING_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'mv', 'move', 'cp', 'copy', 'tee', 'dd', 'touch',
]);

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function resolveToolRiskClass(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  ctx?: RiskContext,
): RiskClass {
  const baseline = ctx?.testBaseline;
  const inBaseline = (p: string | undefined): boolean =>
    p !== undefined && baseline !== undefined && baseline.isBaselineTest(p);
  const a: Readonly<Record<string, unknown>> = args ?? {};

  switch (toolName) {
    case 'read_file':
    case 'list_dir':
    case 'grep':
    case 'glob':
    case 'git_status':
    case 'git_diff':
    case 'git_log':
      return 'READ_ONLY';
    case 'write_file':
    case 'edit_file':
      return inBaseline(str(a['path'])) ? 'DESTRUCTIVE' : 'MODIFY_WORKSPACE';
    case 'git_add':
    case 'git_commit':
      return 'MODIFY_WORKSPACE';
    case 'delete_file':
      return 'DESTRUCTIVE';
    case 'move_file':
      return inBaseline(str(a['path'])) || inBaseline(str(a['to'])) ? 'DESTRUCTIVE' : 'SYSTEM';
    case 'run_command': {
      const command = typeof a['command'] === 'string' ? a['command'] : '';
      const argv = Array.isArray(a['args']) ? (a['args'] as unknown[]) : undefined;
      const inv = normalizeInvocation(command, argv as readonly string[] | undefined);
      const risk = classifyShellInvocation(inv);
      if (risk !== 'SYSTEM' && risk !== 'PACKAGE_INSTALL') return risk;
      if (baseline !== undefined && TEST_MUTATING_SHELL_COMMANDS.has(inv.name)) {
        if (extractShellArguments(inv).fileCandidates.some((c) => baseline.isBaselineTest(c))) {
          return 'DESTRUCTIVE';
        }
      }
      return risk;
    }
    default:
      return 'SYSTEM';
  }
}
