# Implementation Plan: P0 Security Hardening (HTTP runtime + dashboard)

## Overview

Test-first, from the pure policy outward: security tests (failing) → pure gate policy +
`HttpTransport` pre-routing gate → CLI config (fail closed) → dashboard sink rewrite + token entry +
fetch-based SSE → XSS/auth tests green → compatibility → docs sync → full verification.
No new dependencies, no new features, no change behind `ObservabilityService`. Commit/push is done
by the main agent afterwards, following `.kiro/steering/commit-gate.md`.

## Tasks

- [x] 1. Transport and config security tests (written first, expected to fail)
  - [x] 1.1 Write `tests/observability-server/http-security.spec.ts`
    - Seeded generators in the `mulberry32` style of `tests/mission/clarification-generators.ts`, ≥100
      iterations per property, tag `// Feature: p0-security-hardening, Property N: <title>`.
    - **Property 1: Gate decision matches the reference order** (independent reference function in the test)
    - **Property 2: Token comparison is exact**
    - **Property 3: No wildcard CORS** (real `HttpTransport` on `listen(0)`)
    - **Property 4: Rejected requests never reach the service** (spy `ObservabilityService` built from the
      fake ports used in `http-transport.spec.ts`; covers `/stream`, `/models/pull`, `/control`, `/goal`,
      `/clarification`, `/plan-choice`, `/config/model`)
    - **Property 5: Error output never contains the token**
    - Examples from design "Testing Strategy": default bind `127.0.0.1`; `listen(0, '0.0.0.0')` without token
      rejects, with token resolves; 401 on `/state`, `/control`, `/goal` (missing / wrong token, token in
      `?token=`); 200/202 with the right token; `/`, `/app.js`, `/health` public under auth with no credentials
      in the assets; foreign Origin 403 on `POST /control` and `GET /state`; allowlisted origin gets exact ACAO +
      `Vary: Origin`; preflight allowed/denied; `text/plain` POST → 415; bad Host 403 on `/`, `/health`, `/state`;
      thrown `Error('boom ' + token)` → 500 `internal error`; 501 message redacted; CSP + `nosniff` on static
      responses; PUT → 405.
    - Compatibility example: `RuntimeClient`-shaped requests (JSON, no Origin, `Host: 127.0.0.1:<port>`) and
      dashboard-iframe same-origin requests on a loopback, tokenless transport get the normal route responses.
    - **Validates: Requirements 1.4, 3.1–3.6, 4.1, 4.2, 4.5, 5.1–5.6, 6.1–6.4, 7.1–7.3, 8.1, 8.2, 8.4, 8.5, 11.1, 11.2, 12.1**
  - [x] 1.2 Write `tests/observability-server/server-security-config.spec.ts`
    - **Property 6: Configuration fails closed**
    - Examples: default host; env token; trimmed file token; both sources → error; unreadable file (message has
      the path, not the content); empty file; token < 16 chars; `--allowed-origins *` and a non-http origin →
      error; `--allowed-hosts` parsing; banner lines from `describeServerSecurity` show host/port/auth state and
      never the token.
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.5, 2.1–2.5, 4.3, 4.4, 5.7, 8.3, 12.2**

- [x] 2. HTTP transport security layer
  - [x] 2.1 Implement `packages/infrastructure/src/observability-server/http-security.ts`
    - `SecurityPolicy`, `RequestMeta`, `GateDecision`, `PUBLIC_ROUTES`, `isLoopbackAddress`, `isWildcardAddress`,
      `buildAllowedHosts`, `normalizeOrigin`, `isJsonContentType`, `extractBearer`, `tokensEqual`
      (SHA-256 digests + `crypto.timingSafeEqual`), `evaluateRequest` (order per design C1 table), `redactSecret`.
    - Export from `observability-server/index.ts`. Only `node:` built-ins.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 7.3, 8.1_
  - [x] 2.2 Wire the gate into `http-transport.ts`
    - `HttpTransportOptions` += `authToken`, `requireAuth`, `allowedHosts`, `allowedOrigins`.
    - `listen`: reject non-loopback host without token, `requireAuth` without token, invalid/`*` origins; build the
      `SecurityPolicy` with the bound port after bind.
    - `handle`: `evaluateRequest` before any `readBody` or route branch; reject / preflight / exact-origin CORS;
      remove `Access-Control-Allow-Origin: *` and the unconditional `OPTIONS → 204`.
    - `sendJson` redacts string values for status ≥ 400; `streamModelPull` redacts its error frame; outer catch →
      `500 { error: 'internal error' }`.
    - `sendHtml` / `sendJs`: `X-Content-Type-Options: nosniff` + CSP from design C2 (no `frame-ancestors`).
    - Update the route comment block at the top of the file with the security notes.
    - _Requirements: 1.4, 3.5, 3.6, 5.1, 5.2, 7.1, 7.2, 8.1, 8.2, 8.5, 11.3_
  - [x] 2.3 Run `http-security.spec.ts`, `http-transport.spec.ts`, `model-admin.spec.ts` and make them pass
    - Fix the implementation, not the existing tests; the existing specs must pass unmodified.
    - _Requirements: 11.3, 11.4, 12.1_

- [x] 3. CLI host, token and allowlist configuration
  - [x] 3.1 Implement `packages/infrastructure/src/observability-server/server-security-config.ts`
    - `ServerSecurityInput`, `ServerSecurityConfig`, `ServerSecurityConfigError`, `AUTH_TOKEN_MIN_LENGTH = 16`,
      `resolveServerSecurityConfig` (rules table in design C3, injected `readFile`), `describeServerSecurity`.
    - Error messages never include the token or the token file content. Export from `observability-server/index.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 4.3, 4.4, 5.7, 8.3_
  - [x] 3.2 Wire `runtime-cli.ts`
    - Read `--host`, `--auth-token-file`, `--allowed-hosts`, `--allowed-origins` and `CODEFORGE_AUTH_TOKEN`; call
      `resolveServerSecurityConfig` at the top of `main()` before DB/model/workspace-lock setup; on
      `ServerSecurityConfigError` print `Error: <message>` and exit 1.
    - Pass `authToken`, `allowedHosts`, `allowedOrigins` to `HttpTransport`; replace `http.listen(port, '0.0.0.0')`
      with `http.listen(port, cfg.host)`; banner prints `describeServerSecurity` lines and the dashboard URL.
    - Update the header usage comment; keep `--api-key` / `CODEFORGE_API_KEY` for the provider key only; no
      `--auth-token <value>` flag.
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 2.6, 4.3, 4.4, 5.7, 8.3_
  - [x] 3.3 Run `server-security-config.spec.ts` and make it pass
    - _Requirements: 12.2_

- [x] 4. Checkpoint: transport and CLI
  - Run `npm run build` and the specs from tasks 1–3. Ensure all tests pass, ask the user if questions arise.

- [x] 5. Dashboard hardening (`dashboard-assets.ts`)
  - [x] 5.1 Rewrite the HTML sinks
    - Add `el`, `escText`, `escAttr`, `safeClass`, `safeUrl`, `clear` helpers and the class allowlists
      (`TASK_STATE_CLASS`, `CHANGE_KIND_CLASS`, `GOV_LEVEL_CLASS`) built from the CSS in `DASHBOARD_HTML`.
    - Fix every sink in the design C4 inventory: `#agentState` (`kv()`), `#governance`, `#changes` (incl. the
      `class='k …'` attribute injection and diff lines), `#taskGraph`, approval banner (`abDetail`), `#files`,
      `#activity` (`insertAdjacentHTML` + raw time), `#chatLog` (`data-sid`, `g.at`, listener attached on the
      element), `#modelSelect` (option `.value` / `.textContent`), `#models`, model and goal error messages.
    - Remove `esc`, `esc2`, `gesc` once unused. Keep static templates literal; any interpolated value uses
      `escText` / `escAttr` for its context.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - [x] 5.2 Add token entry, `api()` wrapper and fetch-based SSE
    - `#authForm` (labelled password input, submit button, `role="status"` message) in `DASHBOARD_HTML`.
    - `authToken` in memory + `sessionStorage` (`codeforge.authToken`), `authHeaders`, `api()`; route every
      `fetch` (incl. `/control`, `/goal`, `/config/model`, `/models/pull`) through `api()`; `onUnauthorized` clears
      the token and shows the form; submit retries `loadConfig`, `refreshModels`, `captureBaseline`, `connect`.
    - `openStream`: `EventSource` when no token; otherwise `openFetchStream` (reader + `TextDecoder`, SSE frame
      parsing, `lastSeq` from `id`, reconnect after 2 s with `from=<lastSeq>`, stop on 401, `AbortController` on
      reconnect/`connect()`).
    - No token in URLs, `localStorage` or cookies; no hardcoded credentials.
    - _Requirements: 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

- [x] 6. Dashboard XSS and auth tests
  - [x] 6.1 Extend `tests/observability-server/dashboard-xss.spec.ts`
    - Stub DOM records `textContent` writes, `className`, `setAttribute`, and created elements (no jsdom).
    - Assert: no payload tag / `on*` attribute / `javascript:` URL in HTML sinks; data-derived `className` values
      are in the allowlists; no `href`/`src` with a non-http(s) scheme; payload strings appear verbatim as text
      (replaces the `sinks.length > 5` guard).
    - Payload corpus (`"'><img …>`, `' onmouseover=…`, `javascript:`, `<script>`, `<iframe srcdoc>`,
      `<svg onload>`) through LLM output, workspace file names, file content (diffs), tool args/results
      (`/changes`, approval banner), session metadata (`/state`, `/sessions`, `/config`), model names, and error
      messages (`/goal`, `/models`, `/config/model`).
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 12.3_
  - [x] 6.2 Write `tests/observability-server/dashboard-auth.spec.ts`
    - Fake fetch answers 401 until a token is set: form shown; every later fetch carries
      `authorization: Bearer <t>`; no URL contains the token; `localStorage` untouched; `/stream` uses fetch
      (FakeEventSource never constructed) and reconnects with `from=<lastSeq>`; a later 401 clears
      `sessionStorage` and re-shows the form; without a token `/stream` uses `EventSource`; asset scan finds no
      hardcoded credentials.
    - _Requirements: 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 12.4_

- [x] 7. Compatibility verification
  - [x] 7.1 Run the existing suites and fix regressions in the transport/dashboard code only
    - `tests/observability-server/http-transport.spec.ts`, `model-admin.spec.ts`,
      `tests/integration/session-resume-e2e.spec.ts`, `tests/integration/plan-options-e2e.spec.ts`,
      `tests/vscode-extension/**`, plus the new specs. Existing tests stay unmodified.
    - Confirm `packages/vscode-extension` is unchanged (RuntimeClient and `getDashboardHtml` iframe work on
      loopback without a token); if it had to change, rebuild `dist/extension.cjs` and the `.vsix`.
    - Confirm no `package.json` dependency was added.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 8. Docs sync
  - [x] 8.1 Update `README.md`
    - CLI options table (next to the `--port` row, ~line 180): `--host`, `--auth-token-file`, `--allowed-hosts`,
      `--allowed-origins`, `CODEFORGE_AUTH_TOKEN`; a short "Remote access" note (loopback default, token required
      off-loopback, dashboard token prompt); "Honest limitations" (no TLS, single shared token, extension
      tokenless/loopback only).
    - _Requirements: 12.5_
  - [x] 8.2 Update `SECURITY_MODEL.md` and `INFRASTRUCTURE_SPEC.md`
    - SECURITY_MODEL: HTTP threat model (LAN exposure, DNS rebinding, CSRF, CORS, XSS), gate order, public vs
      protected routes, token handling, design decisions D1–D3 (fetch-based SSE chosen, cookie deferred).
    - INFRASTRUCTURE_SPEC: dashboard/transport section with the security options, status codes and CSP.
    - _Requirements: 12.5_
  - [x] 8.3 Update `PROJECT_STATUS.md`, `PHASE_12_SIGNOFF.md` and stale claims
    - PROJECT_STATUS: row "Observability dashboard (HTTP + SSE)" (security notes), "Last updated" line (date +
      new test counts), limitations list, shipped list.
    - PHASE_12_SIGNOFF addendum: row "Interaction benchmark, first run" `*(this commit)*` → `acf006f`; add a
      "P0 security hardening" row with `*(this commit)*`.
    - Grep the docs for stale claims (`0.0.0.0`, "permissive CORS", "no auth", "tighten in a hardened deploy")
      and fix them; update `ROADMAP.md` only if it describes this work.
    - _Requirements: 12.5_

- [x] 9. Final verification
  - [x] 9.1 Run `npm run build`, `eslint .` (0 problems) and `depcruise` (0 violations)
    - _Requirements: 11.5, 12.1, 12.2, 12.3, 12.4_
  - [x] 9.2 Run the WSL suite `scripts/_wsl-tmp.sh` in the background (~200 s), read the output, and compare with
    the baseline 2131 tests / 226 files; make `PROJECT_STATUS.md` counts match the result
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 11.4, 12.1, 12.2, 12.3, 12.4_

## Notes

- All tasks are required, including the test tasks (security fixes must ship with their regression tests).
- No property-testing dependency: properties use the repo's seeded `mulberry32` generators.
- No change to governance/approval semantics or anything behind `ObservabilityService`; no P1 work
  (extension token support, TLS, cookies, rate limiting).
- Do not commit `*.vsix`, `packages/vscode-extension/package-lock.json`, temp logs or tokens.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "5.1"] },
    { "id": 3, "tasks": ["2.3", "3.2", "5.2"] },
    { "id": 4, "tasks": ["3.3", "6.1", "6.2"] },
    { "id": 5, "tasks": ["7.1"] },
    { "id": 6, "tasks": ["8.1", "8.2", "8.3"] },
    { "id": 7, "tasks": ["9.1"] },
    { "id": 8, "tasks": ["9.2"] }
  ]
}
```
