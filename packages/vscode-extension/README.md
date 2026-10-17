# CodeForge — VS Code Extension

Observe and control a running CodeForge agent runtime from VS Code, using native VS Code UI
(tree views, status bar, commands) rather than only an embedded dashboard.

## What you get

- **CodeForge activity-bar container** with three live tree views (polled every ~2s):
  - **Sessions** — recent sessions from the runtime; attach to one (inline action or
    `CodeForge: Connect`).
  - **Task Graph** — the task DAG as a tree (dependents nested under their dependency), each
    node iconed + coloured by state (running / passed / blocked / failed / verifying / …).
  - **Changes** — the agent's change transcript; click a diffable change to open a native
    **side-by-side diff** in the editor (`vscode.diff`).
  - **Governance** — the runtime's safety events: verification verdicts, failure classes,
    recovery actions, completion-gate challenges, tool approvals/denials.
- **Approval notifications** — when the agent parks on a tool call needing approval, a native
  warning notification pops with **Approve / Deny** buttons (named with the tool + target).
- **Status bar** item showing the attached session's state + passed/total + budget pressure.
- **Submit Goal** — queue a new goal at the runtime (`POST /goal`).
- **Open Dashboard** — the full web dashboard in a webview panel (secondary view).

## Commands

- **CodeForge: Connect to Runtime** — set the HTTP URL and pick/attach a session.
- **CodeForge: Submit Goal / Refresh / Open Dashboard**.
- **CodeForge: Pause / Resume / Cancel / Checkpoint** — control, routed through the ControlPlane
  (OB-006: the SAME ControlRequest shape as the dashboard and Telegram; surface = `vscode`).

## Architecture

The extension is a pure **client** of the runtime (INFRASTRUCTURE_SPEC §14): it never duplicates
the runtime. It reads over HTTP (`/state`, `/sessions`, `/events`, `/changes`, `/config`) and
submits control via `POST /control`. The decision logic lives in offline-testable pure modules
(`runtime-client.ts`, `view-model.ts`, `vscode-control-mapper.ts`); `extension.ts` only binds
them to the VS Code API.

## Requirements

A CodeForge runtime server must be running (ObservabilityServer + HttpTransport from
`@codeforge/infrastructure`). The extension connects to it over HTTP (default
`http://127.0.0.1:9500`).
