// Dataset loader (infrastructure I/O) — reads a benchmark definition JSON file from disk and
// validates it through the pure agent-core loader. Keeps all parsing/validation deterministic in
// agent-core; this adapter only does the file read.
import { readFileSync } from 'node:fs';
import { validateBenchmark, type Benchmark } from '@codeforge/agent-core';

export class DatasetLoadError extends Error {
  constructor(message: string) { super(message); this.name = 'DatasetLoadError'; }
}

/** Read + validate a benchmark JSON file. Throws DatasetLoadError with all field errors joined. */
export function loadBenchmarkFile(path: string): Benchmark {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new DatasetLoadError(`cannot read/parse ${path}: ${String(e)}`); }
  const result = validateBenchmark(raw);
  if (!result.ok) {
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new DatasetLoadError(`invalid benchmark ${path}: ${detail}`);
  }
  return result.value;
}
