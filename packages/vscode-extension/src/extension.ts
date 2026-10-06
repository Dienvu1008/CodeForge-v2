// extension.ts (P9.11) — the thin VS Code API edge. This file is ONLY compiled by the
// extension's own build (esbuild), never by root tsc --build. It imports `vscode` and
// delegates all logic to the pure VscodeControlMapper + fetch to the HttpTransport.
//
// The extension is a CLIENT of CodeForge (INFRASTRUCTURE_SPEC §14): it does not duplicate
// the runtime. It observes via HTTP reads and controls via POST /control, using the same
// ControlRequest shape as dashboard/Telegram (OB-006). Strict CSP for webview. Approval
// UI shows full info. No authority.
import * as vscode from 'vscode';
import {
  commandToControlRequest,
  isControlCommand,
  type VscodeCommandId,
} from './vscode-control-mapper.js';

let runtimeUrl = 'http://127.0.0.1:9500';
let sessionId = '';

export function activate(context: vscode.ExtensionContext): void {
  // Connect command: ask for runtime URL + session id.
  context.subscriptions.push(
    vscode.commands.registerCommand('codeforge.connect', async () => {
      const url = await vscode.window.showInputBox({ prompt: 'Runtime URL', value: runtimeUrl });
      if (url !== undefined) runtimeUrl = url;
      const sid = await vscode.window.showInputBox({ prompt: 'Session ID', value: sessionId });
      if (sid !== undefined) sessionId = sid;
      vscode.window.showInformationMessage(`CodeForge: connected to ${runtimeUrl}, session ${sessionId}`);
    }),
  );

  // Dashboard webview command.
  context.subscriptions.push(
    vscode.commands.registerCommand('codeforge.dashboard', () => {
      const panel = vscode.window.createWebviewPanel('codeforge', 'CodeForge Dashboard', vscode.ViewColumn.One, {
        enableScripts: true,
        // Strict CSP: only allow the runtime origin for fetch + scripts.
        localResourceRoots: [],
      });
      panel.webview.html = getDashboardHtml(runtimeUrl, sessionId);
    }),
  );

  // Control commands: pause / resume / cancel / checkpoint.
  for (const cmd of ['codeforge.pause', 'codeforge.resume', 'codeforge.cancel', 'codeforge.checkpoint'] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, async () => {
        if (sessionId === '') {
          vscode.window.showWarningMessage('CodeForge: no session connected. Run "CodeForge: Connect" first.');
          return;
        }
        if (!isControlCommand(cmd)) return;
        const request = commandToControlRequest(cmd as VscodeCommandId, sessionId);
        try {
          const res = await fetch(`${runtimeUrl}/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          });
          const body = (await res.json()) as { admission?: { admitted: boolean; reason?: string }; record?: { result: string } };
          const ok = body.admission?.admitted;
          vscode.window.showInformationMessage(
            `CodeForge ${request.intent}: ${ok ? `admitted (${body.record?.result})` : `rejected (${body.admission?.reason})`}`,
          );
        } catch (err) {
          vscode.window.showErrorMessage(`CodeForge: ${err instanceof Error ? err.message : 'network error'}`);
        }
      }),
    );
  }
}

export function deactivate(): void {
  // nothing to clean up — all state lives on the runtime
}

/** A minimal webview HTML that loads the dashboard from the runtime's HTTP server. */
function getDashboardHtml(url: string, sid: string): string {
  // The webview embeds the dashboard in an iframe pointing at the runtime's HTTP server.
  // This reuses 100% of the P9.3 dashboard; the extension is just a frame.
  // CSP allows only the runtime origin.
  const csp = `default-src 'none'; frame-src ${url}; style-src 'unsafe-inline';`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>body{margin:0;padding:0;overflow:hidden} iframe{width:100%;height:100vh;border:none}</style>
</head>
<body>
<iframe src="${url}/?session=${encodeURIComponent(sid)}"></iframe>
</body>
</html>`;
}
