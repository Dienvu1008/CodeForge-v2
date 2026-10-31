---
inclusion: always
---

# CodeForge commit gate (applies to every session)

CodeForge's architecture and invariants must never regress silently. Before ANY `git commit` /
`git push` in this repo, the agent completes ALL of the steps below. If a step fails, do not commit:
fix it (or report it to the user) first. Never use `--no-verify` unless the user explicitly asks.

## 1. Docs sync (do this BEFORE running checks)

For every behavior, flag, endpoint, setting, event type, or limitation the change adds or alters,
update the docs that describe it so they match the code:

- `README.md` — CLI options table, VS Code extension section, "Project direction",
  "Honest limitations".
- `PROJECT_STATUS.md` — the status matrix row(s), the "Last updated" line (date + test counts),
  the limitations list, the "shipped" list.
- `ROADMAP.md` — mark finished items DONE; keep next steps truthful.
- `PHASE_*_ROADMAP.md` / `PHASE_*_SIGNOFF.md` for the active phase when a milestone lands.
- `*_SPEC.md`, `INVARIANTS.md` / `invariants.yaml` when a contract or invariant changes.
- `packages/*/README.md` for package-level surfaces (e.g. VS Code commands/settings).

Grep the docs for stale claims about the feature (e.g. "not built", "remains", "TODO") and fix
them. The pre-push hook rejects pushes that change code without touching a project `.md`, unless a
commit carries the trailer `Docs-Reviewed: <reason>` — use it only when no doc truly describes
the change, and say why.

## 2. Verification (authoritative = WSL)

1. `npm run build` (tsc --build).
2. Full suite in WSL: `scripts/_wsl-tmp.sh` (npm ci, build, typecheck, full vitest incl.
   `tests/invariants`, eslint, depcruise). Run it in the background, ~200 s, then read the output.
   Report file/test counts and compare with the previous baseline in `PROJECT_STATUS.md`.
3. `eslint .` → 0 problems; `depcruise` → 0 violations (architecture boundaries).
4. If `packages/vscode-extension` changed: rebuild `dist/extension.cjs` and the `.vsix`.

## 3. Commit hygiene

- Stage specific paths; never commit `*.vsix`, `packages/vscode-extension/package-lock.json`,
  temp logs, or secrets (API keys).
- English commit message: summary line + what changed + what was verified (test counts).
- The `pre-push` git hook (`npm run hooks:install`) re-runs docs-sync, build, lint, depcruise and
  invariants as a safety net. It does not replace step 2.