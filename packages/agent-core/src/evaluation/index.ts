// CodeForge Evaluation module (agent-core) — pure logic for the Task Correctness axis.
//
// Everything here is deterministic and I/O-free: loading/validating benchmark definitions,
// evaluating a run's results into verdicts + metrics, aggregating into an EvaluationResult,
// recording/comparing baselines, and rendering reports. The actual EXECUTION of a benchmark
// (isolated workspace, driving the real runtime, persistence) lives in infrastructure — the
// agent-core layer never touches the filesystem or a process (DC-002).
export {
  validateBenchmarkTask,
  validateBenchmark,
  type BenchmarkLoadError,
  type BenchmarkLoadResult,
} from './benchmark-loader.js';
export {
  computeMetrics,
  metricValue,
  type CaseEvidence,
} from './metrics.js';
export {
  evaluateCase,
  aggregate,
  type CheckOutcome,
  type EvaluateCaseInput,
} from './evaluator.js';
export {
  compareToBaseline,
  renderReport,
} from './regression.js';
