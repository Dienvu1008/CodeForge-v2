// SWE-bench dataset loader (infrastructure I/O) — reads a SWE-bench dataset file (JSON array or
// JSONL, one record per line) from disk and runs it through the PURE agent-core adapter to get
// validated BenchmarkTask + SweBenchSetup bundles. All parsing/validation logic lives in
// agent-core; this adapter only does the file read + line split.
import { readFileSync } from 'node:fs';
import {
  sweBenchInstancesToTasks,
  type SweBenchTaskWithSetup,
  type SweBenchAdapterOptions,
} from '@codeforge/agent-core';

export class SweBenchDatasetError extends Error {
  constructor(message: string) { super(message); this.name = 'SweBenchDatasetError'; }
}

/** Parse the file body as either a JSON array of records or JSONL (one JSON object per line). */
export function parseSweBenchRecords(body: string): unknown[] {
  const trimmed = body.trim();
  if (trimmed === '') return [];
  // JSON array form.
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new SweBenchDatasetError('top-level JSON must be an array of records');
    return parsed;
  }
  // JSONL form: one record per non-blank line.
  const records: unknown[] = [];
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      throw new SweBenchDatasetError(`line ${i + 1}: invalid JSON (${String(e)})`);
    }
  }
  return records;
}

/**
 * Read + validate a SWE-bench dataset file into task/setup bundles. Throws SweBenchDatasetError
 * with all field errors joined when any record is invalid (never silently drops a bad record).
 */
export function loadSweBenchDataset(
  path: string,
  options: SweBenchAdapterOptions = {},
): readonly SweBenchTaskWithSetup[] {
  let body: string;
  try { body = readFileSync(path, 'utf8'); }
  catch (e) { throw new SweBenchDatasetError(`cannot read ${path}: ${String(e)}`); }

  let records: unknown[];
  try { records = parseSweBenchRecords(body); }
  catch (e) {
    if (e instanceof SweBenchDatasetError) throw e;
    throw new SweBenchDatasetError(`cannot parse ${path}: ${String(e)}`);
  }

  const result = sweBenchInstancesToTasks(records, options);
  if (!result.ok) {
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new SweBenchDatasetError(`invalid SWE-bench dataset ${path}: ${detail}`);
  }
  return result.value;
}
