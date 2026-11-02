# Requirements Document

## Introduction

P0 Security Hardening closes the security gaps found in the audit of the runtime HTTP server
(`HttpTransport`) and the web dashboard (`dashboard-assets.ts`):

- `runtime-cli.ts` binds the server to `0.0.0.0` (all interfaces) while there is no authentication,
  so anyone on the network can read sessions, workspace files and config, submit goals, approve tool
  calls and pull models.
- `HttpTransport` sends `Access-Control-Allow-Origin: *`, answers every `OPTIONS` with 204, does not
  validate the `Host` header (DNS rebinding) and accepts any content type on `POST` (CSRF via simple
  form posts).
- Error responses echo `err.message`.
- The dashboard writes attacker-controllable data (LLM output, workspace file names and contents,
  tool arguments and results, session metadata, model names, error messages) into `innerHTML` with
  escapers that do not escape quotes, allowing HTML and attribute injection
  (`tests/observability-server/dashboard-xss.spec.ts` currently fails).

This phase is hardening only. It adds no product features, does not change governance or approval
semantics, and never bypasses ToolGateway, Policy, Approval, TaskGraph, VerificationEngine or
CompletionGate: every check sits in front of routing, so a rejected request never reaches
`ObservabilityService`. The CLI and VS Code extension workflows on loopback keep working unchanged
and without a token. No new dependencies and no new frontend framework.

Out of scope (P1 or later): token support in the VS Code extension, TLS termination, cookie
sessions, rate limiting, multi-user identities or roles, audit of who made a request, and any
refactoring not required by the fixes above.

## Glossary

- **Runtime_CLI**: the runtime entrypoint `packages/infrastructure/src/cli/runtime-cli.ts`.
- **Http_Transport**: `HttpTransport` in `observability-server/http-transport.ts`.
- **Security_Gate**: the request check that Http_Transport runs before routing (Host, Origin,
  preflight, authentication, content type).
- **Observability_Service**: `ObservabilityService`, the protocol-agnostic service behind
  Http_Transport; every runtime read and mutation goes through it.
- **Dashboard**: the static web client `DASHBOARD_HTML` / `DASHBOARD_JS` served at `/` and `/app.js`.
- **Bind_Host**: the network address Http_Transport listens on.
- **Loopback_Host**: a Bind_Host of `127.0.0.1` (or any `127.0.0.0/8` address), `::1` or `localhost`.
- **Auth_Token**: the shared secret supplied via the `CODEFORGE_AUTH_TOKEN` environment variable or
  the file named by `--auth-token-file`.
- **Auth_Required**: the server mode in which every protected route requires a valid Auth_Token;
  active when an Auth_Token is configured.
- **Bearer_Credential**: an `Authorization: Bearer <token>` request header.
- **Allowed_Host_Set**: the `Host` header values the server accepts: `127.0.0.1:<port>`,
  `localhost:<port>`, `[::1]:<port>`, plus hostnames configured explicitly by the operator, all with
  the bound port.
- **Allowed_Origin_Set**: origins configured explicitly by the operator for cross-origin access;
  empty by default.
- **Same_Origin**: an `Origin` header equal to `http://<Host header>` where the Host header is in
  Allowed_Host_Set.
- **Static_Asset_Route**: `GET /` and `GET /app.js`.
- **Health_Route**: `GET /health`.
- **Protected_Route**: every route other than Static_Asset_Route and Health_Route, including the
  reads `/state`, `/trace`, `/audit`, `/metrics`, `/events`, `/changes`, `/sessions`,
  `/workspace/files`, `/config`, `/stream`, `/models` and the mutations `/config/model`, `/control`,
  `/goal`, `/clarification`, `/plan-choice`, `/models/pull`.
- **Runtime_Client**: `RuntimeClient` in `packages/vscode-extension/src/runtime-client.ts`.
- **Dashboard_Webview**: the VS Code webview from `getDashboardHtml` that embeds the Dashboard in an
  iframe loaded from `http://127.0.0.1:<port>/?session=…`.
- **HTML_Sink**: `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.
- **Untrusted_Data**: any value the Dashboard receives from the network.

## Requirements

### Requirement 1: Loopback binding by default

**User Story:** As an operator, I want the runtime to listen only on loopback unless I opt in, so
that starting CodeForge never exposes my workspace to the network by accident.

#### Acceptance Criteria

1. WHEN Runtime_CLI starts without `--host`, THE Runtime_CLI SHALL bind Http_Transport to `127.0.0.1`.
2. WHERE `--host <address>` is given, THE Runtime_CLI SHALL bind Http_Transport to that address.
3. IF the Bind_Host is not a Loopback_Host and no Auth_Token is configured, THEN THE Runtime_CLI SHALL
   exit with a non-zero status and an error message naming the missing token before Http_Transport
   starts listening.
4. WHEN Http_Transport is constructed with a non-loopback Bind_Host and no Auth_Token, THE
   Http_Transport SHALL reject the `listen` call with an error.
5. THE Runtime_CLI SHALL print the Bind_Host, the port and whether Auth_Required is active in the
   startup banner, and the banner SHALL omit the Auth_Token value.
6. THE Runtime_CLI usage text SHALL document `--host`, `--auth-token-file`, `--allowed-hosts`,
   `--allowed-origins` and `CODEFORGE_AUTH_TOKEN`.

### Requirement 2: Token supply

**User Story:** As an operator, I want to supply the access token without putting it on the command
line, so that the token does not leak through shell history or process listings.

#### Acceptance Criteria

1. WHERE the `CODEFORGE_AUTH_TOKEN` environment variable is set to a non-empty value, THE Runtime_CLI
   SHALL use that value as the Auth_Token.
2. WHERE `--auth-token-file <path>` is given, THE Runtime_CLI SHALL read the Auth_Token from that file
   with surrounding whitespace removed.
3. IF both `CODEFORGE_AUTH_TOKEN` and `--auth-token-file` are given, THEN THE Runtime_CLI SHALL exit
   with a non-zero status and an error stating that only one token source is allowed.
4. IF the token file cannot be read or contains an empty value, THEN THE Runtime_CLI SHALL exit with a
   non-zero status and an error that names the file path and omits the file contents.
5. IF the Auth_Token is shorter than 16 characters, THEN THE Runtime_CLI SHALL exit with a non-zero
   status and an error stating the minimum length.
6. THE Runtime_CLI SHALL keep `--api-key` and `CODEFORGE_API_KEY` dedicated to the model provider key
   and SHALL accept no token value as a command-line argument.

### Requirement 3: Bearer authentication

**User Story:** As an operator exposing the runtime beyond loopback, I want every data and control
route to require my token, so that only I can read or steer the agent.

#### Acceptance Criteria

1. WHILE Auth_Required is active, WHEN a request to a Protected_Route arrives without a Bearer_Credential,
   THE Security_Gate SHALL respond with HTTP 401, a `WWW-Authenticate: Bearer` header and the body
   `{ "error": "unauthorized" }`.
2. WHILE Auth_Required is active, WHEN a request to a Protected_Route carries a Bearer_Credential whose
   token differs from the Auth_Token, THE Security_Gate SHALL respond with HTTP 401 and the body
   `{ "error": "unauthorized" }`.
3. THE Security_Gate SHALL compare the presented token with the Auth_Token using a constant-time
   comparison whose duration is independent of the position of the first differing character and of
   the presented token length.
4. THE Security_Gate SHALL read credentials only from the `Authorization` header and SHALL treat a
   token in the URL query string or path as absent.
5. WHILE Auth_Required is active, THE Security_Gate SHALL serve Static_Asset_Route and Health_Route
   without a Bearer_Credential, and the responses of those routes SHALL contain no runtime data and no
   credentials.
6. WHILE Auth_Required is inactive, THE Security_Gate SHALL accept requests to Protected_Route without
   a Bearer_Credential when all other Security_Gate checks pass.

### Requirement 4: Host header validation

**User Story:** As an operator, I want requests addressed to an unexpected host name to be refused, so
that a malicious web page cannot reach my local runtime through DNS rebinding.

#### Acceptance Criteria

1. WHEN a request arrives whose `Host` header is not in Allowed_Host_Set, THE Security_Gate SHALL
   respond with HTTP 403 and the body `{ "error": "host not allowed" }`.
2. WHEN a request arrives without a `Host` header, THE Security_Gate SHALL respond with HTTP 403 and
   the body `{ "error": "host not allowed" }`.
3. WHERE `--allowed-hosts <name,...>` is given, THE Runtime_CLI SHALL add each listed hostname,
   combined with the bound port, to Allowed_Host_Set.
4. WHERE the Bind_Host is a specific non-wildcard address, THE Runtime_CLI SHALL add that address,
   combined with the bound port, to Allowed_Host_Set.
5. THE Security_Gate SHALL apply Host validation to every route, including Static_Asset_Route and
   Health_Route.

### Requirement 5: Cross-origin policy

**User Story:** As a user, I want other websites open in my browser to be unable to read from or write
to the runtime, so that browsing the web cannot leak or alter my agent's state.

#### Acceptance Criteria

1. THE Http_Transport SHALL omit the wildcard value `*` from every `Access-Control-Allow-Origin`
   response header.
2. WHEN a request carries an `Origin` header that is in Allowed_Origin_Set, THE Http_Transport SHALL set
   `Access-Control-Allow-Origin` to that exact origin and add `Vary: Origin`.
3. WHEN an `OPTIONS` request carries an `Origin` header in Allowed_Origin_Set, THE Security_Gate SHALL
   respond with HTTP 204 and allow the methods `GET, POST, OPTIONS` and the headers
   `authorization, content-type`.
4. WHEN an `OPTIONS` request carries no `Origin` header or an `Origin` header outside
   Allowed_Origin_Set, THE Security_Gate SHALL respond with HTTP 403 without CORS allow headers.
5. WHEN a request to a Protected_Route carries an `Origin` header that is neither Same_Origin nor in
   Allowed_Origin_Set, THE Security_Gate SHALL respond with HTTP 403 and the body
   `{ "error": "origin not allowed" }`.
6. WHEN a request carries no `Origin` header, THE Security_Gate SHALL treat the request as a
   non-browser client and continue with the remaining checks.
7. WHERE `--allowed-origins <origin,...>` is given, THE Runtime_CLI SHALL add each listed origin to
   Allowed_Origin_Set, and IF a listed origin is `*` or is not a valid `http`/`https` origin, THEN THE
   Runtime_CLI SHALL exit with a non-zero status and an error naming the invalid entry.

### Requirement 6: CSRF protection for state-changing requests

**User Story:** As a user, I want mutations to be impossible to trigger from a plain HTML form or
image tag, so that a hostile page cannot submit goals or approve tool calls on my behalf.

#### Acceptance Criteria

1. WHEN a `POST` request arrives whose `Content-Type` media type is not `application/json`, THE
   Security_Gate SHALL respond with HTTP 415 and the body `{ "error": "content-type must be application/json" }`.
2. THE Security_Gate SHALL accept a `Content-Type` of `application/json` with parameters (for example
   `application/json; charset=utf-8`) and SHALL compare the media type case-insensitively.
3. WHEN a `POST` request carries an `Origin` header that is neither Same_Origin nor in
   Allowed_Origin_Set, THE Security_Gate SHALL respond with HTTP 403 and the body
   `{ "error": "origin not allowed" }`.
4. WHEN a request uses a method other than `GET`, `POST` or `OPTIONS`, THE Security_Gate SHALL respond
   with HTTP 405 and the body `{ "error": "method not allowed" }`.

### Requirement 7: Rejected requests stay outside the runtime

**User Story:** As a maintainer, I want a guarantee that rejected requests have no effect, so that the
security layer cannot be bypassed through partial processing.

#### Acceptance Criteria

1. WHEN the Security_Gate rejects a request, THE Http_Transport SHALL send the rejection response
   without reading the request body and without calling any Observability_Service method.
2. THE Http_Transport SHALL run the Security_Gate before routing for every request, including
   Static_Asset_Route, Health_Route, `/stream` and `/models/pull`.
3. THE Security_Gate SHALL evaluate checks in the order Host, method, preflight, Origin,
   authentication, content type, so that each rejection reports the first failing check.

### Requirement 8: No secret leakage

**User Story:** As an operator, I want the token to never appear in logs, responses or frontend assets,
so that a leaked log or screenshot does not grant access.

#### Acceptance Criteria

1. WHEN Http_Transport sends an error response (status 4xx or 5xx, including SSE error frames from
   `/models/pull`), THE Http_Transport SHALL replace every occurrence of the Auth_Token in the error
   text with `[redacted]`.
2. WHEN Http_Transport catches an unexpected error during routing, THE Http_Transport SHALL respond
   with HTTP 500 and the body `{ "error": "internal error" }`.
3. THE Runtime_CLI SHALL keep the Auth_Token out of console output, startup banner and error messages.
4. THE Dashboard SHALL contain no hardcoded token, API key or password in `DASHBOARD_HTML` or
   `DASHBOARD_JS`.
5. THE Http_Transport SHALL serve Static_Asset_Route responses with the headers
   `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` that allows scripts only from the
   same origin and forbids plugin objects.

### Requirement 9: Dashboard token handling and authenticated streaming

**User Story:** As an operator using the dashboard remotely, I want to enter my token once per browser
tab and have live updates keep working, so that remote monitoring works without tokens in URLs.

#### Acceptance Criteria

1. WHEN a Dashboard request receives HTTP 401, THE Dashboard SHALL show a password-type token input
   with an accessible label and a submit button.
2. WHEN the user submits a token, THE Dashboard SHALL keep the token in memory and in
   `sessionStorage` only, and SHALL retry the pending loads.
3. WHILE a token is stored, THE Dashboard SHALL send the token as a Bearer_Credential on every request
   it makes, including `/stream` and `/models/pull`.
4. THE Dashboard SHALL keep the token out of every request URL and out of `localStorage` and cookies.
5. WHILE a token is stored, THE Dashboard SHALL read `/stream` through `fetch` with a readable body
   stream and parse the server-sent-event frames, resuming from the last received `id` through the
   `from` query parameter after a disconnect.
6. WHILE no token is stored, THE Dashboard SHALL read `/stream` through `EventSource` as before.
7. WHEN a request made with a stored token receives HTTP 401, THE Dashboard SHALL clear the stored token
   and show the token input again.

### Requirement 10: Dashboard output encoding

**User Story:** As a user, I want hostile content produced by the model or present in my workspace to
show as plain text, so that viewing the dashboard can never run attacker code.

#### Acceptance Criteria

1. THE Dashboard SHALL render Untrusted_Data as text through `textContent`, DOM element creation or
   DOM property assignment.
2. WHERE a Dashboard renderer keeps building HTML strings, THE Dashboard SHALL encode Untrusted_Data
   for the target context: text content with `&`, `<`, `>` escaped, and quoted attribute values with
   `&`, `<`, `>`, `"` and `'` escaped.
3. WHEN the Dashboard derives a CSS class name from Untrusted_Data (task state, change kind, event
   level), THE Dashboard SHALL use the value only if it is in a fixed allowlist of class names and
   SHALL use a neutral fallback class otherwise.
4. WHEN the Dashboard sets a URL attribute from Untrusted_Data, THE Dashboard SHALL accept only
   relative URLs and the `http` and `https` schemes and SHALL drop all other values, including
   `javascript:` and `data:`.
5. THE Dashboard SHALL set `<option>` values and labels in the model selector through DOM properties.
6. WHEN Untrusted_Data containing HTML markup, quote characters, event-handler attribute text or a
   `javascript:` URL is rendered, THE Dashboard SHALL produce no new element, no event-handler
   attribute and no `javascript:` URL in the document.

### Requirement 11: Compatibility

**User Story:** As a VS Code extension user, I want everything that works today on my machine to keep
working, so that the hardening does not break my workflow.

#### Acceptance Criteria

1. WHILE the Bind_Host is a Loopback_Host and no Auth_Token is configured, THE Http_Transport SHALL
   accept Runtime_Client requests (Node `fetch`, `content-type: application/json`, no `Origin` header,
   `Host: 127.0.0.1:<port>`) on every route Runtime_Client uses.
2. WHILE the Bind_Host is a Loopback_Host and no Auth_Token is configured, THE Http_Transport SHALL
   serve the Dashboard_Webview iframe page and accept the same-origin requests the Dashboard makes
   from that iframe.
3. THE Http_Transport SHALL keep the existing route paths, status codes and response bodies for
   requests that pass the Security_Gate.
4. THE existing test suites `tests/observability-server/http-transport.spec.ts`,
   `tests/observability-server/model-admin.spec.ts`, `tests/integration/session-resume-e2e.spec.ts`,
   `tests/integration/plan-options-e2e.spec.ts` and `tests/vscode-extension/**` SHALL pass.
5. THE change SHALL add no runtime or development dependency.

### Requirement 12: Verification and documentation

**User Story:** As a maintainer, I want the security guarantees covered by tests and described in the
docs, so that they cannot regress silently.

#### Acceptance Criteria

1. THE test suite SHALL include `tests/observability-server/http-security.spec.ts` covering
   Requirements 1.4, 3, 4, 5, 6, 7 and 8.
2. THE test suite SHALL include server security configuration tests covering Requirements 1.1, 1.3, 2
   and 5.7.
3. THE test suite SHALL include `tests/observability-server/dashboard-xss.spec.ts` covering attribute
   injection, HTML injection, script execution attempts, `javascript:` URLs, and malicious data from
   LLM output, workspace file names, file content, tool arguments and results, session metadata and
   error messages.
4. THE test suite SHALL include a Dashboard authentication test covering Requirement 9.
5. THE documentation SHALL describe `--host`, `--auth-token-file`, `--allowed-hosts`,
   `--allowed-origins`, `CODEFORGE_AUTH_TOKEN` and the remote-access threat model in `README.md`,
   `SECURITY_MODEL.md`, `INFRASTRUCTURE_SPEC.md`, `PROJECT_STATUS.md` and `PHASE_12_SIGNOFF.md`.
