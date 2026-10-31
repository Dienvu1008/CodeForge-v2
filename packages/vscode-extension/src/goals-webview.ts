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
//                         { type:'clarifyResult', requestId, ok: boolean, message: string }
//   webview → extension: { type:'submit', description: string }
//                         { type:'clarify', sessionId, requestId, answers: Record<qid, string> }
//                           (every question id present; '' = skipped → runtime default assumption)
//                         { type:'ready' }   (sent once on load so the extension pushes state)
//
// Goal clarification (goal-clarification-gate, Phase 1): when an entry carries `clarification`
// (derived by the extension from the session's events), the panel renders an accessible answer
// form under the reply with a `needs input` chip. Typed values survive re-renders; the first input
// is focused once per requestId; buttons are disabled while a submission is in flight.

import type { OpenClarificationView } from './goal-history.js';

/** The minimal entry shape the webview renders (subset of GoalEntry + display fields). */
export interface GoalEntryView {
  readonly localId: string;
  readonly description: string;
  readonly submittedAt: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed';
  readonly sessionId?: string;
  readonly goalId?: string;
  /** Open clarification request for this entry's session (AWAITING_HUMAN), if any. */
  readonly clarification?: OpenClarificationView;
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
  .chip.needs-input { background: var(--vscode-inputValidation-warningBackground, #c906);
                      border: 1px solid var(--vscode-inputValidation-warningBorder, #c90); }
  .clarify { white-space: normal; }
  .clarify form { display: flex; flex-direction: column; gap: 10px; margin: 0; }
  .clarify fieldset { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 10px; margin: 0; }
  .clarify legend { padding: 0 4px; }
  .clarify .q { display: flex; flex-direction: column; gap: 4px; }
  .clarify .opt { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .clarify input[type="text"] { padding: 5px 7px; font-family: inherit; font-size: inherit;
           color: var(--vscode-input-foreground); background: var(--vscode-input-background);
           border: 1px solid var(--vscode-input-border); border-radius: 4px; }
  .clarify input:focus-visible, .clarify button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .clarify .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .clarify button { padding: 4px 12px; cursor: pointer; border: none; border-radius: 4px;
           color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .clarify button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .clarify button:disabled { opacity: .5; cursor: default; }
  .clarify [role="status"] { font-size: 11px; opacity: .85; min-height: 1em; }
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

  // Attribute-safe escaping (esc() alone does not escape quotes).
  function escAttr(s) { return esc(String(s)).split('"').join('&quot;'); }
  // Restrict to characters that are always safe inside an HTML id / CSS selector.
  function safeId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }

  // ── Clarification form state (survives re-renders) ──
  const drafts = new Map();        // requestId + '/' + qid → typed value
  const focusedReqs = new Set();   // requestIds whose first input has already been focused
  const inFlight = new Set();      // requestIds with a submission awaiting clarifyResult
  const statusMsgs = new Map();    // requestId → last aria-live message

  function inputId(requestId, qid) { return 'cf-' + safeId(requestId) + '-' + safeId(qid); }

  function clarifyFormHtml(e) {
    const c = e.clarification;
    const req = c.requestId;
    let h = '<form data-req="' + escAttr(req) + '" data-session="' + escAttr(e.sessionId || '') + '">';
    h += '<div>The goal is ambiguous. Answer what you can; leave a field empty to let the runtime assume a default.</div>';
    for (const q of c.questions) {
      const id = inputId(req, q.id);
      const field = '<input type="text" id="' + id + '" data-req="' + escAttr(req) + '" data-qid="' + escAttr(q.id) + '" maxlength="500" />';
      const opts = Array.isArray(q.suggestedOptions) ? q.suggestedOptions : [];
      if (opts.length > 0) {
        h += '<fieldset class="q"><legend>' + esc(q.text) + '</legend>';
        opts.forEach((o, i) => {
          const rid = id + '-o' + i;
          h += '<div class="opt"><input type="radio" name="' + id + '-opt" id="' + rid + '" value="' + escAttr(o) +
               '" data-target="' + id + '" /><label for="' + rid + '">' + esc(o) + '</label></div>';
        });
        h += '<label for="' + id + '">Your answer (pick an option above or type your own)</label>' + field + '</fieldset>';
      } else {
        h += '<div class="q"><label for="' + id + '">' + esc(q.text) + '</label>' + field + '</div>';
      }
    }
    h += '<div class="actions"><button type="submit" data-action="send">Send answers</button>' +
         '<button type="button" class="secondary" data-action="defaults">Use defaults for all</button></div>';
    h += '<div role="status" aria-live="polite">' + esc(statusMsgs.get(req) || '') + '</div>';
    h += '</form>';
    return h;
  }

  function setBusy(form, busy) {
    for (const b of form.querySelectorAll('button')) b.disabled = busy;
  }

  function sendClarify(form, useDefaults) {
    const req = form.getAttribute('data-req');
    if (inFlight.has(req)) return;
    const answers = {};
    for (const inp of form.querySelectorAll('input[type="text"][data-qid]')) {
      answers[inp.getAttribute('data-qid')] = useDefaults ? '' : inp.value;
    }
    inFlight.add(req);
    setBusy(form, true);
    statusMsgs.set(req, 'Sending answers…');
    const live = form.querySelector('[role="status"]');
    if (live) live.textContent = 'Sending answers…';
    vscode.postMessage({ type: 'clarify', sessionId: form.getAttribute('data-session'), requestId: req, answers: answers });
  }

  function findForm(req) {
    for (const f of log.querySelectorAll('form[data-req]')) if (f.getAttribute('data-req') === req) return f;
    return null;
  }

  function saveDrafts() {
    for (const inp of log.querySelectorAll('input[type="text"][data-qid]')) {
      drafts.set(inp.getAttribute('data-req') + '/' + inp.getAttribute('data-qid'), inp.value);
    }
  }

  function restoreDrafts() {
    for (const inp of log.querySelectorAll('input[type="text"][data-qid]')) {
      const v = drafts.get(inp.getAttribute('data-req') + '/' + inp.getAttribute('data-qid'));
      if (v === undefined) continue;
      inp.value = v;
      for (const r of log.querySelectorAll('input[type="radio"]')) {
        if (r.getAttribute('data-target') === inp.id && r.value === v) r.checked = true;
      }
    }
  }

  // Event delegation on #log: listeners survive innerHTML re-renders.
  log.addEventListener('submit', (ev) => {
    const form = ev.target;
    if (!form || !form.matches || !form.matches('form[data-req]')) return;
    ev.preventDefault();
    sendClarify(form, false);
  });
  log.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action="defaults"]') : null;
    if (!btn) return;
    const form = btn.closest('form[data-req]');
    if (form) sendClarify(form, true);
  });
  log.addEventListener('change', (ev) => {
    const r = ev.target;
    if (!r || r.type !== 'radio' || !r.checked) return;
    const target = document.getElementById(r.getAttribute('data-target'));
    if (target) { target.value = r.value; drafts.set(target.getAttribute('data-req') + '/' + target.getAttribute('data-qid'), r.value); }
  });

  function render(entries, connected, url) {
    status.textContent = connected ? ('Connected · ' + url) : ('Not connected · ' + (url || 'runtime offline'));
    // Preserve typed values and the focused field across the innerHTML replacement.
    saveDrafts();
    const active = document.activeElement;
    const activeId = active && active.id && log.contains(active) ? active.id : null;
    const sel = activeId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
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

      const hasClarify = !!(e.clarification && e.clarification.requestId && Array.isArray(e.clarification.questions) &&
                            e.clarification.questions.length > 0);
      const r = document.createElement('div');
      r.className = 'msg reply';
      r.innerHTML = esc(replyText(e)) + '<span class="chip ' + esc(e.status) + '">' + esc(e.status) + '</span>' +
                    (hasClarify ? '<span class="chip needs-input">needs input</span>' : '');
      log.appendChild(r);

      if (hasClarify) {
        const c = document.createElement('div');
        c.className = 'msg reply clarify';
        c.innerHTML = clarifyFormHtml(e);
        log.appendChild(c);
        const form = c.querySelector('form');
        if (form && inFlight.has(e.clarification.requestId)) setBusy(form, true);
      }
    }
    restoreDrafts();
    log.scrollTop = log.scrollHeight;
    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) {
        el.focus();
        if (sel && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(sel[0], sel[1]); } catch (_) { /* radio */ } }
      }
    }
    // Focus the first answer field exactly once per new requestId.
    for (const f of log.querySelectorAll('form[data-req]')) {
      const req = f.getAttribute('data-req');
      if (focusedReqs.has(req)) continue;
      focusedReqs.add(req);
      const first = f.querySelector('input[type="text"]');
      if (first && !activeId) first.focus();
    }
  }

  function onClarifyResult(m) {
    const req = m.requestId;
    const msg = typeof m.message === 'string' ? m.message : (m.ok ? 'Answers sent.' : 'Failed to send answers.');
    statusMsgs.set(req, msg);
    if (!m.ok) inFlight.delete(req); // keep inFlight on success: the form disappears on the next refresh
    const form = findForm(req);
    if (!form) return;
    const live = form.querySelector('[role="status"]');
    if (live) live.textContent = msg;
    if (!m.ok) setBusy(form, false);
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
    else if (m && m.type === 'clarifyResult') onClarifyResult(m);
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
