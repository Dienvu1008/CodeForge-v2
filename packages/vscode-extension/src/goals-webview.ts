/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// goals-webview.ts (P12.23) — PURE HTML/JS for the Goals webview panel. No `vscode` import; the
// extension edge creates the WebviewPanel and relays messages. The webview is a thin VIEW: it
// renders the goal history it is given (postMessage {type:'history', entries}) and sends a
// {type:'submit', description} back when the user enters a goal. All binding/status logic lives
// in goal-history.ts (unit tested); the extension owns the RuntimeClient and the poll loop.
//
// Message protocol (extension ⇄ webview):
//   extension → webview: { type:'history', entries: GoalEntryView[], connected: boolean, url }
//   webview → extension: { type:'submit', description: string }
//                         { type:'ready' }   (sent once on load so the extension pushes state)

/** The minimal entry shape the webview renders (subset of GoalEntry + display fields). */
export interface GoalEntryView {
  readonly localId: string;
  readonly description: string;
  readonly submittedAt: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed';
  readonly sessionId?: string;
  readonly goalId?: string;
}

/** Build the full HTML document for the Goals panel. `nonce` secures the inline script (CSP). */
export function goalsPanelHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
  #status { padding: 6px 12px; font-size: 11px; opacity: .8; border-bottom: 1px solid var(--vscode-panel-border); }
  #log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 90%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .goal { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .reply { align-self: flex-start; background: var(--vscode-editorWidget-background);
           border: 1px solid var(--vscode-panel-border); }
  .meta { font-size: 11px; opacity: .7; margin-top: 4px; }
  .chip { display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 8px; margin-left: 6px;
          vertical-align: middle; }
  .chip.queued    { background:#8884; } .chip.running  { background:#39f6; }
  .chip.completed { background:#2a6;  } .chip.failed   { background:#c33; color:#fff; }
  #empty { opacity: .6; align-self: center; margin-top: 24px; }
  #composer { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border); }
  #input { flex: 1; resize: none; min-height: 38px; max-height: 160px; padding: 8px;
           font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground);
           background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; }
  #send { padding: 0 14px; cursor: pointer; color: var(--vscode-button-foreground);
          background: var(--vscode-button-background); border: none; border-radius: 6px; }
  #send:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<div id="status">Not connected.</div>
<div id="log"><div id="empty">No goals yet. Describe one below and the runtime will work on it.</div></div>
<div id="composer">
  <textarea id="input" placeholder="Describe a goal (Enter to send, Shift+Enter for newline)…"></textarea>
  <button id="send">Send</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const status = document.getElementById('status');

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function replyText(e) {
    switch (e.status) {
      case 'queued':    return 'Goal queued' + (e.goalId ? ' (' + e.goalId + ')' : '') + ' — waiting for a session…';
      case 'running':   return 'Working on it' + (e.sessionId ? ' · session ' + e.sessionId : '') + ' — planning, executing, verifying.';
      case 'completed': return 'Done' + (e.sessionId ? ' · session ' + e.sessionId : '') + '. Verification passed.';
      case 'failed':    return 'Failed' + (e.sessionId ? ' · session ' + e.sessionId : '') + '. See the Governance view for details.';
      default:          return '';
    }
  }

  function render(entries, connected, url) {
    status.textContent = connected ? ('Connected · ' + url) : ('Not connected · ' + (url || 'runtime offline'));
    if (!entries || entries.length === 0) {
      log.innerHTML = '<div id="empty">No goals yet. Describe one below and the runtime will work on it.</div>';
      return;
    }
    log.innerHTML = '';
    for (const e of entries) {
      const g = document.createElement('div');
      g.className = 'msg goal';
      g.innerHTML = esc(e.description) + '<div class="meta">' + esc(e.submittedAt) + '</div>';
      log.appendChild(g);

      const r = document.createElement('div');
      r.className = 'msg reply';
      r.innerHTML = esc(replyText(e)) + '<span class="chip ' + e.status + '">' + e.status + '</span>';
      log.appendChild(r);
    }
    log.scrollTop = log.scrollHeight;
  }

  function submit() {
    const text = input.value.trim();
    if (text === '') return;
    vscode.postMessage({ type: 'submit', description: text });
    input.value = '';
    input.focus();
  }

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m && m.type === 'history') render(m.entries, m.connected, m.url);
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
