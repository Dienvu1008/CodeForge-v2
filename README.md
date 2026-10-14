# CodeForge v2

CodeForge is being built to become an **autonomous software-engineering agent** — a system that
takes a goal and carries it to verified, working software with minimal human intervention. Not a
chatbot with tools: a user goal flows through understanding → planning → a task graph →
tool-governed execution → verification → recovery, with full observability.

The foundation that exists today is a **deterministic runtime kernel** — the trustworthy base the
agent is grown on. The vision is the full agent; the kernel is how we get there safely.

> **Central law, preserved everywhere: the LLM proposes; the deterministic runtime decides and enforces.**

CodeForge runs against local models via [Ollama](https://ollama.com/), keeps every piece of state
in an append-only SQLite event log, and governs every tool call through an explicit policy +
approval gate. The agent is never the authority on its own success — a deterministic verification
step decides pass/fail.

---

## What CodeForge is (and is not)

**The goal** is an autonomous software-engineering agent. **What runs today** is the kernel that
turns a goal into verified work — the part the agent needs to be trustworthy before it can be
trusted to act on its own:

```
User Goal → Mission Understanding → Complexity / Risk / Uncertainty → Capability check
→ (advisory) Model routing → Planning → Task Graph → Tool-Governed Execution
→ Verification → Recovery → Observability → Learning / Evaluation
```

**It is not** a free-form chat assistant. Nothing the model emits touches your workspace directly:
file writes and commands go through a `ToolGateway` with autonomy levels and human-in-the-loop
approval; task completion is decided by deterministic checks, not by the model claiming "done".

### The two-axis correctness model

CodeForge measures itself on two independent axes (`EVALUATION_MODEL.md`):

- **Runtime Integrity** — state / graph / tool / approval / budget / verification invariants (the
  kernel). This is mature and invariant-tested (~180 invariants across phases 0–12).
- **Task Correctness** — does the agent actually solve the user's problem (the intelligence). This
  is now measurable end-to-end via the evaluation/benchmark system, but real-model task-correctness
  numbers are still being gathered.

Keeping these separate is deliberate: a weak local model may produce poor task correctness while
the kernel's integrity stays intact. Most current limitations are intelligence/product gaps, **not**
integrity gaps.

---

## Architecture at a glance

A TypeScript monorepo (`npm` workspaces, Node ≥ 20):

| Package | Role |
|---|---|
| `packages/agent-core` | Pure domain + orchestration. No I/O, no infrastructure imports. Domain models, state machines, task graph, scheduler, budget, context builder, planner, recovery, mission intelligence (advisory), evaluation. |
| `packages/infrastructure` | Adapters: SQLite event log + repositories, Ollama model gateway, process supervisor, Node tool executor, code intelligence (Tree-sitter / LSP), observability HTTP+SSE server, CLI, Telegram transport. |
| `packages/testing` | Deterministic test doubles (e.g. `FakeModel`, fake process supervisor) for CI without a network or a live model. |
| `packages/vscode-extension` | Thin HTTP client: connect to a running runtime, dashboard webview, control commands. |
| `tests` | Vitest suites: unit, integration, invariants, cross-platform, evaluation. |

Dependency direction is enforced by dependency-cruiser (`agent-core` must never import
infrastructure / models / tools; no cycles).

### Key building blocks

- **Deterministic state machines** for session / task / tool-call lifecycles.
- **Task graph** with canonical hashing (Blake3) and validated mutations — dependencies live only
  as graph edges.
- **ToolGateway** with autonomy levels (`full` / `edits` / `readonly`) and an approval coordinator
  for human-in-the-loop decisions.
- **Verification engine + completion gate** — real checks run through a process supervisor; the
  gate, not the model, decides task success.
- **Recovery** — RETRY / FIX / ESCALATE / ABORT implemented (REPLAN / ROLLBACK are still stubs).
- **Mission Intelligence (advisory, Phase 12)** — intake, complexity/risk/uncertainty, capability
  verification, model routing, architecture + a deterministic gate. Advisory by design: its main
  control-flow effect is the Architecture Gate halting for a human. Two parts now also *steer* the
  agent — stated goal assumptions (injected into the executor prompt) and the context strategy
  (sizes the context pipeline).
- **Observability** — append-only event log, HTTP + SSE dashboard, control plane (pause / resume /
  stop / approve).
- **Evaluation / benchmark** — isolated runner driving the real kernel, deterministic evaluator,
  metrics, baseline + regression detection, and a native seed dataset (CF-001..010).

---

## Getting started

### Prerequisites

- **Node.js ≥ 20**
- **A model provider.** CodeForge talks to models through a provider-agnostic gateway, so you can use either:
  - **[Ollama](https://ollama.com/)** locally (default) — `http://localhost:11434` with a model pulled, e.g. `ollama pull qwen2.5-coder`; or
  - **Any OpenAI Chat Completions-compatible provider** — commercial or free cloud (OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, …) or a local server (LM Studio, llama.cpp, vLLM, LiteLLM). Pass `--provider openai-compatible`, the `…/v1` base URL via `--endpoint`, and the key via the `CODEFORGE_API_KEY` env var.

### Install & build

```bash
npm install
npm run build
```

### Run the quality gates

```bash
npm test            # full Vitest suite
npm run lint        # eslint
npm run depcruise   # dependency-direction + cycle checks
```

### Run the runtime (CLI + dashboard)

The runtime starts, processes the first goal, then stays alive as a goal-queue worker with a
dashboard at `http://localhost:<port>/`:

```bash
npm start -- \
  --workspace /path/to/your/project \
  --model qwen2.5-coder \
  --goal "Add an isEven helper to src/util.js" \
  --port 9500 \
  --autonomy edits \
  --mission on
```

Enqueue more goals against the running process:

```bash
curl -X POST http://localhost:9500/goal \
  -H 'content-type: application/json' \
  -d '{"description":"Write a test for the reverse() function"}'
```

To use a cloud provider instead of local Ollama:

```bash
$env:CODEFORGE_API_KEY = "sk-..."   # PowerShell (or: export CODEFORGE_API_KEY=sk-...)
npm start -- \
  --workspace /path/to/your/project \
  --provider openai-compatible \
  --endpoint https://api.openai.com/v1 \
  --model gpt-4o-mini \
  --goal "Add an isEven helper to src/util.js" \
  --autonomy edits
```

(For OpenRouter use `--endpoint https://openrouter.ai/api/v1` and a model id like
`anthropic/claude-3.5-sonnet`; for a local LM Studio server, `--endpoint http://localhost:1234/v1`.)

#### CLI options

| Flag | Default | Meaning |
|---|---|---|
| `--workspace <path>` | cwd | Project root the agent operates on. |
| `--goal <text>` | — | The first goal. The runtime stays alive afterward; `POST /goal` enqueues more. |
| `--provider <name>` | `ollama` | `ollama` (local) or `openai-compatible` (any OpenAI Chat Completions API). |
| `--model <name>` | `qwen2.5-coder` | Model name/id (for a cloud provider, that provider's model id). |
| `--endpoint <url>` | provider default | Ollama server URL, or the cloud provider's `…/v1` base URL. |
| `--api-key <key>` | — | API key for a cloud provider. Prefer the `CODEFORGE_API_KEY` env var. Never logged. |
| `--port <number>` | `9500` | Dashboard HTTP port. |
| `--db <path>` | `.codeforge/runtime.db` | SQLite database file. |
| `--max-steps <n>` | `40` | Max orchestrator iterations. |
| `--autonomy <level>` | `edits` | `full` / `edits` / `readonly` — which tool risk classes auto-approve vs. require a human decision. |
| `--mission <on\|off>` | `off` | Advisory Mission Intelligence stage before planning. |
| `--learning <on\|off>` | `off` | Advisory learning plane for recovery ordering. |
| `--model-routes <path>` | — | JSON file routing each purpose to a provider/model (see below). Replaces `--provider`/`--model`/`--endpoint`. |
| `--model-registry <path>` | — | JSON file listing multiple models (id + tier + capabilities) so `--mission on` can route by task complexity (see `examples/model-registry.example.json`). |

> Tip for a smooth demo with a small local model: `--autonomy full` avoids approval prompts for
> commands. With weaker models, prefer concrete, well-specified goals (acceptance criteria the
> runtime can verify) — see the limitations below.

### Per-purpose model routing (cost/quality split)

Instead of one model for everything, you can route each kind of work to a different
provider/model: run reasoning-heavy purposes (`plan`, `architect`) on a strong (e.g. commercial)
model and mechanical / I/O-heavy purposes (`execute`, `summarize`) on a cheaper or local one. All
behind the single gateway the runtime uses — routing is deterministic and config-driven (the LLM
never picks its own model).

Point `--model-routes` at a JSON file (see `examples/model-routes.example.json`). The file holds
**no API keys** — each cloud entry names an environment variable via `apiKeyEnv`:

```json
{
  "default": { "provider": "ollama", "model": "qwen2.5-coder", "endpoint": "http://localhost:11434" },
  "routes": {
    "plan":      { "provider": "openai-compatible", "model": "gpt-4o-mini", "endpoint": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
    "architect": { "provider": "openai-compatible", "model": "gpt-4o",      "endpoint": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" }
  }
}
```

```bash
$env:OPENAI_API_KEY = "sk-..."
npm start -- --workspace /path/to/project --model-routes examples/model-routes.example.json --goal "..." --mission on
```

Valid purposes: `plan`, `critique`, `replan`, `execute`, `analyze_failure`, `summarize`,
`architect`. Any purpose not listed uses `default`.

There is also **mission-driven routing**: with `--mission on` and a `--model-registry` file listing
several models, the Mission Intelligence stage picks one to fit the task (trivial → fast/cheap,
complex → stronger) and the runtime switches the active model to it. See
`examples/model-registry.example.json` (three local Ollama models tiered SMALL/MEDIUM/STRONG):

```bash
npm start -- --workspace /path/to/project --model-registry examples/model-registry.example.json --mission on --goal "..."
```

Without a registry file the gateway stays on the single configured model (no-op). Routing is
deterministic and runtime-decided — the LLM never picks its own model.

### Package the CLI (single file)

```bash
npm run bundle:cli    # → dist-cli/codeforge.cjs (native deps kept external)
```

### VS Code extension

`packages/vscode-extension` is a thin client that connects to a running runtime and shows the
dashboard in a webview with control commands. It is built as a `.vsix` but not yet published.

---

## Evaluation

The evaluation system measures Task Correctness end-to-end. The first recorded baseline runs the
native seed benchmark (CF-001..010) through the **real kernel** driven by a deterministic
`FakeModel`:

| Field | Value |
|---|---|
| Baseline label | `codeforge-0.12-fakemodel` |
| Benchmark | `codeforge-native` v0.1.0 (CF-001..010, 10 categories) |
| Agent / model | codeforge 0.12.0 · FakeModel (CI-deterministic, no network) |
| Success rate | **3 / 10** (the scripted-solvable cases) |

This is a **harness baseline, not an intelligence baseline**: the FakeModel was scripted to solve
only 3 tasks; the other 7 were correctly caught by deterministic checks (the agent is not the
authority on its own success). It proves the loop end-to-end — isolation → governed execution →
external verification → verdict → metrics → baseline. A real-Ollama run would replace 3/10 with a
genuine task-correctness figure; the harness is ready for it. See `EVALUATION.md`.

---

## Project direction

**North star: a fully autonomous software-engineering agent** — one that understands a goal, plans,
writes and changes code, verifies its own work against reality, recovers from failures, and learns
from them, with the human stepping in by choice rather than necessity. The deterministic kernel is
not the destination; it is the safety substrate that makes autonomy trustworthy. Every step toward
autonomy keeps the central law intact: *the LLM proposes, the runtime decides and enforces.*

The path there, in increasing autonomy:

1. **Trustworthy kernel (today)** — governed tools, deterministic verification, invariant-tested
   state. The agent cannot do anything the runtime does not allow or cannot check.
2. **Supervised agent** — the intelligence layer actively steers execution (model routing, context,
   planning strategy, architecture), with human approval on risky actions. *In progress: context
   strategy and goal assumptions already steer; routing and planner consumption are next.*
3. **Self-correcting agent** — a complete recovery vocabulary (incl. REPLAN / ROLLBACK) plus the
   learning plane turning past outcomes into better future decisions.
4. **Autonomous agent** — the human sets the goal and reviews the result; the agent drives the
   loop end-to-end, with evaluation gating every self-improvement.

Development is moving from **phase-driven** toward **evidence-driven**: no step toward more
autonomy ships without a before/after benchmark proving it actually helps.

```
Goal → Roadmap → Implementation → Evaluation → Evidence → Improvement → New baseline
```

Highest-value next work (evidence-gated by before/after benchmark runs):

1. **Wire Mission Intelligence further into execution** — context strategy already sizes the
   context pipeline; next is applying the routed model at execution time and letting the Planner
   consume planning-mode / expert-profile / architecture. (Step 2 → 3 of the autonomy path.)
2. **Goal clarification** — detection (Tier A) and assume-and-state (Tier B1/B2) are done; an
   optional stop-and-ask path (Tier C) remains.
3. **Finish the recovery vocabulary** — implement REPLAN and ROLLBACK. (Toward step 3.)
4. **Measure real-model task correctness** — run the benchmark against a live model so autonomy
   claims rest on evidence, not hope.
5. **Product surface** — task-graph visualization, richer execution trace, polished VS Code `.vsix`.

Full detail lives in `ROADMAP.md` (trajectory) and `PROJECT_STATUS.md` (what the software actually
does today, verified against the source tree).

---

## Honest limitations (today)

- **Mission Intelligence steers execution only partially.** Its control-flow effect is the
  Architecture Gate halting for a human; goal assumptions and context strategy now steer the
  executor, but routed-model-at-execution and planner consumption of planning-mode/architecture are
  not wired yet.
- **Real-model task correctness is not yet measured.** The harness is ready; the numbers aren't in.
- **REPLAN / ROLLBACK recovery are stubs.**
- **Model routing selects an id but doesn't switch the executing model** (a runtime switch exists
  for the dashboard, but routing decisions aren't applied automatically).
- **Local small models (6–9B) are weak agents** — they plan acceptably but often loop on reads,
  emit malformed tool-call JSON, or over-decompose. The runtime mitigates this but cannot make a
  weak model competent; agent quality is model-bound.
- **Product surface is minimal** — a functional dashboard + thin VS Code client, no graph view.

None of these violate a kernel invariant — they are intelligence/product gaps, which is exactly the
distinction the two-axis model exists to make.

---

## Documentation map

| Document | What it holds |
|---|---|
| `PROJECT_STATUS.md` | Authoritative, living status matrix — what the software actually does today. |
| `ROADMAP.md` | Product trajectory that survives across work sessions. |
| `Coding Agent Architecture Target.md` | The product/architecture target. |
| `EVALUATION_MODEL.md` · `EVALUATION.md` | The two-axis model and the evaluation system. |
| `*_SPEC.md` | Context, verification, state-machine, workspace, security, infrastructure, migration specs. |
| `INVARIANTS.md` · `invariants.yaml` | The enforced invariants. |
| `PHASE_*` | Per-phase roadmaps and sign-offs. |
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE). You may use, modify, and
distribute this software under its terms. Contributions are accepted under the same
license (Apache-2.0 §5).
