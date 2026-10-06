# CodeForge — VS Code Extension

Observe and control a running CodeForge agent runtime from VS Code.

## Commands

- **CodeForge: Connect to Runtime** — set the HTTP server URL and session ID.
- **CodeForge: Open Dashboard** — open the agent dashboard in a webview panel.
- **CodeForge: Pause / Resume / Cancel / Checkpoint** — control commands routed through the ControlPlane.

## Requirements

A CodeForge runtime server must be running (ObservabilityServer + HttpTransport from
`@codeforge/infrastructure`). The extension connects to it over HTTP.
