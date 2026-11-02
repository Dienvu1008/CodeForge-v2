/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Dashboard assets (P9.3) — a minimal, framework-free static client served by
// HttpTransport. It is a pure CONSUMER: it renders the RuntimeProjection + ActivityTrace
// and sends ControlRequests to POST /control. It holds no authoritative state (OB-005)
// and reaches the kernel only through the admitted control path (OB-006).
//
// Kept as inline string constants so the server has nothing to read from disk (zero file
// I/O, easy to package). Strict: no external scripts, no inline event handlers in HTML
// (handlers are attached in app.js), no secrets.
//
// Auth (P0 security hardening): when the server requires a bearer token, the first 401 reveals
// #authForm; the typed token lives in memory + sessionStorage only and is sent as an
// `Authorization: Bearer` header by api() — never in a URL, localStorage or a cookie. With a token,
// /stream is read through fetch + a body reader (EventSource cannot send headers); without one
// (loopback default) the dashboard keeps using EventSource.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CodeForge — Observability</title>
<style>
  :root { color-scheme: dark; }
  body { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background:#0e1116; color:#d7dde5; }
  header { padding: 10px 16px; background:#161b22; border-bottom:1px solid #222; display:flex; gap:12px; align-items:center; }
  header input { background:#0e1116; color:#d7dde5; border:1px solid #30363d; padding:4px 8px; border-radius:4px; }
  header button { background:#21262d; color:#d7dde5; border:1px solid #30363d; padding:4px 10px; border-radius:4px; cursor:pointer; }
  header button:hover { background:#30363d; }
  header select { background:#0e1116; color:#d7dde5; border:1px solid #30363d; padding:3px 6px; border-radius:4px; }
  header label { color:#8b949e; display:flex; gap:4px; align-items:center; }
  #workspace { color:#8b949e; max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  main { display:grid; grid-template-columns: 1fr 1fr; gap:12px; padding:12px 16px; }
  section { background:#161b22; border:1px solid #222; border-radius:6px; padding:10px 12px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; margin:0 0 8px; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; }
  .kv b { color:#8b949e; font-weight:600; }
  .controls button { margin:2px 4px 2px 0; }
  ul { list-style:none; margin:0; padding:0; max-height:300px; overflow:auto; }
  li { padding:2px 0; border-bottom:1px solid #1c2128; }
  .cat { color:#58a6ff; }
  .task.active { color:#3fb950; } .task.blocked { color:#d29922; } .task.passed { color:#8b949e; }
  .bar { height:6px; background:#30363d; border-radius:3px; overflow:hidden; }
  .bar > span { display:block; height:100%; background:#58a6ff; }
  #status { color:#8b949e; }
  /* Access-token entry: hidden until a request is answered with 401 (P0 security hardening). */
  #authForm { display:flex; gap:6px; align-items:center; }
  #authForm[hidden] { display:none; }
  #authStatus { color:#d29922; }
  /* Goals chat panel */
  #chatLog { max-height:360px; overflow:auto; display:flex; flex-direction:column; gap:8px; }
  .msg { border:1px solid #222; border-radius:8px; padding:8px 10px; background:#0e1116; }
  .msg .goalText { white-space:pre-wrap; word-break:break-word; }
  .msg .meta { margin-top:6px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; color:#8b949e; font-size:11px; }
  .chip { padding:1px 7px; border-radius:10px; font-size:10px; text-transform:uppercase; letter-spacing:.04em; border:1px solid #30363d; }
  .chip.queued { color:#d29922; border-color:#5a4a1a; }
  .chip.running { color:#58a6ff; border-color:#1f3a5a; }
  .chip.completed { color:#3fb950; border-color:#1f5a2e; }
  .chip.aborted, .chip.failed { color:#f85149; border-color:#5a1f22; }
  .chip.awaiting_human { color:#d29922; border-color:#5a4a1a; }
  .msg a.view { color:#58a6ff; cursor:pointer; text-decoration:underline; }
  #chatForm { display:flex; gap:8px; margin-top:10px; }
  #chatForm textarea { flex:1; min-height:38px; max-height:120px; resize:vertical; background:#0e1116; color:#d7dde5; border:1px solid #30363d; border-radius:4px; padding:6px 8px; font:inherit; }
  /* Reasoning lines in Live Activity (commercial-agent style "thinking") */
  li.reasoning { color:#c9d1d9; border-bottom:1px solid #1c2128; padding:4px 0; }
  li.reasoning b { color:#d7dde5; }
  li.reasoning i { color:#8b949e; font-style:italic; }
  ul.reasoning-sub { margin:4px 0 2px 16px; padding:0; max-height:none; }
  ul.reasoning-sub li { border:none; padding:1px 0; color:#9aa4b2; }
  /* Task graph (SVG DAG): nodes colored by state, edges = depends_on */
  #taskGraph { width:100%; overflow:auto; max-height:420px; }
  #taskGraph svg { display:block; }
  #taskGraph .edge { stroke:#30363d; stroke-width:1.5; fill:none; }
  #taskGraph .node rect { rx:5; ry:5; stroke-width:1.5; fill:#0e1116; }
  #taskGraph .node text { fill:#d7dde5; font:11px ui-monospace, Menlo, monospace; }
  #taskGraph .node .st { font-size:9px; }
  #taskGraph .node.pending  rect { stroke:#30363d; }
  #taskGraph .node.ready    rect { stroke:#1f3a5a; }
  #taskGraph .node.active   rect { stroke:#3fb950; fill:#0f1f14; }
  #taskGraph .node.blocked  rect { stroke:#d29922; }
  #taskGraph .node.passed   rect { stroke:#2ea043; }
  #taskGraph .node.failed   rect { stroke:#f85149; fill:#1f1113; }
  #taskGraph .node.verifying rect { stroke:#8957e5; }
  #taskGraph .node.superseded rect { stroke:#444c56; stroke-dasharray:3 3; }
  .legend { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; font-size:10px; color:#8b949e; }
  .legend span { display:flex; gap:4px; align-items:center; }
  .legend i { width:9px; height:9px; border-radius:2px; display:inline-block; border:1px solid; }
  /* Change transcript: the diffs the agent produced (reconstructed from tool-call args) */
  #changes { max-height:420px; overflow:auto; }
  .change { border:1px solid #222; border-radius:6px; margin-bottom:8px; background:#0e1116; }
  .change .chd { display:flex; gap:8px; align-items:center; padding:6px 10px; border-bottom:1px solid #1c2128; flex-wrap:wrap; }
  .change .chd .k { padding:1px 7px; border-radius:10px; font-size:10px; text-transform:uppercase; border:1px solid #30363d; color:#8b949e; }
  .change .chd .k.edit { color:#58a6ff; border-color:#1f3a5a; }
  .change .chd .k.write { color:#3fb950; border-color:#1f5a2e; }
  .change .chd .k.delete { color:#f85149; border-color:#5a1f22; }
  .change .chd .k.move { color:#d29922; border-color:#5a4a1a; }
  .change .chd .p { color:#d7dde5; }
  .change .chd .t { color:#8b949e; margin-left:auto; font-size:11px; }
  .change pre { margin:0; padding:8px 10px; overflow:auto; max-height:220px; font:11px/1.45 ui-monospace, Menlo, monospace; }
  .change pre .add { color:#3fb950; } .change pre .del { color:#f85149; }
  /* Governance timeline: verification / recovery / gate / approval events as a vertical thread */
  #governance { max-height:420px; overflow:auto; }
  .gov { display:flex; gap:8px; align-items:baseline; padding:3px 0; border-bottom:1px solid #1c2128; }
  .gov .gi { width:18px; text-align:center; flex:0 0 18px; }
  .gov .gt { color:#8b949e; font-size:11px; flex:0 0 58px; }
  .gov .gm { flex:1; }
  .gov.pass .gm b { color:#3fb950; } .gov.fail .gm b { color:#f85149; }
  .gov.recover .gm b { color:#58a6ff; } .gov.gate .gm b { color:#d29922; }
  .gov.approve .gm b { color:#3fb950; } .gov.deny .gm b { color:#f85149; }
  .gov .sub { color:#8b949e; }
  /* Prominent approval banner — the agent is BLOCKED waiting for a human decision. */
  #approvalBanner { display:none; margin:0 16px; margin-top:12px; border:1px solid #8a6d1a;
    background:#2a2410; border-radius:8px; padding:12px 14px; animation:apulse 2s ease-in-out infinite; }
  #approvalBanner.show { display:block; }
  #approvalBanner .ab-top { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  #approvalBanner .ab-badge { background:#d29922; color:#1a1203; font-weight:700; font-size:11px;
    text-transform:uppercase; letter-spacing:.04em; padding:3px 9px; border-radius:10px; }
  #approvalBanner .ab-title { color:#f0d58a; font-weight:600; }
  #approvalBanner .ab-detail { margin-top:8px; color:#d7dde5; }
  #approvalBanner .ab-detail code { background:#0e1116; border:1px solid #30363d; border-radius:4px; padding:1px 6px; }
  #approvalBanner .ab-risk { display:inline-block; margin-left:6px; font-size:10px; text-transform:uppercase;
    border:1px solid #5a1f22; color:#f85149; border-radius:10px; padding:1px 7px; }
  #approvalBanner .ab-actions { margin-top:10px; display:flex; gap:8px; }
  #approvalBanner .ab-actions button { padding:6px 16px; border-radius:5px; cursor:pointer; border:1px solid #30363d; font-weight:600; }
  #approvalBanner #abApprove { background:#1f5a2e; color:#d7f5df; border-color:#2ea043; }
  #approvalBanner #abDeny { background:#5a1f22; color:#f5d7d9; border-color:#f85149; }
  @keyframes apulse { 0%,100% { box-shadow:0 0 0 0 rgba(210,153,34,.35); } 50% { box-shadow:0 0 0 4px rgba(210,153,34,0); } }
</style>
</head>
<body>
<header>
  <strong>CodeForge</strong>
  <input id="session" placeholder="session id" size="22" />
  <button id="connect">Connect</button>
  <span id="status">disconnected</span>
  <form id="authForm" hidden>
    <label for="authToken">Access token</label>
    <input id="authToken" type="password" autocomplete="off" />
    <button type="submit">Unlock</button>
    <span id="authStatus" role="status" aria-live="polite"></span>
  </form>
  <span style="margin-left:auto; display:flex; gap:8px; align-items:center">
    <span id="workspace" title="agent workspace">workspace: —</span>
    <label>model:
      <select id="modelSelect"><option value="">—</option></select>
    </label>
  </span>
</header>
<div id="approvalBanner" role="alert">
  <div class="ab-top">
    <span class="ab-badge">Approval needed</span>
    <span class="ab-title">The agent is paused, waiting for your decision</span>
  </div>
  <div class="ab-detail" id="abDetail"></div>
  <div class="ab-actions"><button id="abApprove">Approve</button><button id="abDeny">Deny</button></div>
</div>
<main>
  <section>
    <h2>Agent State</h2>
    <div id="agentState" class="kv"></div>
    <h2 style="margin-top:12px">Context / Budget</h2>
    <div class="bar"><span id="budgetBar" style="width:0%"></span></div>
    <div id="budgetText"></div>
  </section>
  <section>
    <h2>Control</h2>
    <div class="controls">
      <button data-intent="pause">Pause</button>
      <button data-intent="resume">Resume</button>
      <button data-intent="cancel">Cancel</button>
      <button data-intent="checkpoint">Checkpoint</button>
    </div>
    <div id="controlResult"></div>
    <h2 style="margin-top:12px">Pending Approval</h2>
    <div id="approval">none</div>
  </section>
  <section>
    <h2>Task Graph</h2>
    <div id="taskGraph"></div>
    <div class="legend">
      <span><i style="border-color:#3fb950;background:#0f1f14"></i>active</span>
      <span><i style="border-color:#2ea043"></i>passed</span>
      <span><i style="border-color:#d29922"></i>blocked</span>
      <span><i style="border-color:#f85149;background:#1f1113"></i>failed</span>
      <span><i style="border-color:#8957e5"></i>verifying</span>
      <span><i style="border-color:#1f3a5a"></i>ready</span>
      <span><i style="border-color:#30363d"></i>pending</span>
    </div>
  </section>
  <section>
    <h2>Result — Workspace Files</h2>
    <div id="resultSummary"></div>
    <ul id="files"></ul>
  </section>
  <section>
    <h2>Live Activity</h2>
    <ul id="activity"></ul>
  </section>
  <section>
    <h2>Changes — what the agent edited</h2>
    <div id="changes"></div>
  </section>
  <section>
    <h2>Governance — verify · recover · gate · approve</h2>
    <div id="governance"></div>
  </section>
  <section>
    <h2>Goals</h2>
    <div id="chatLog"></div>
    <form id="chatForm">
      <textarea id="goalInput" placeholder="Describe a goal for the runtime, then press Enter (Shift+Enter for newline)"></textarea>
      <button id="submitGoal" type="submit">Send</button>
    </form>
  </section>
  <section>
    <h2>Models</h2>
    <div class="controls">
      <input id="pullInput" placeholder="model to download, e.g. qwen2.5-coder:7b" size="34" />
      <button id="pullBtn">Download</button>
      <button id="refreshModels">Refresh</button>
    </div>
    <div class="bar"><span id="pullBar" style="width:0%"></span></div>
    <div id="pullStatus"></div>
    <ul id="models"></ul>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>`;

export const DASHBOARD_JS = `"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var es = null;
  var sessionId = "";

  function setStatus(s) { $("status").textContent = s; }

  // ── Access token (P0 security hardening, Requirement 9) ──
  // The token is typed by the operator after a 401 and kept in memory + sessionStorage (per tab)
  // ONLY: never in a URL or any long-lived browser storage. Every request goes through api(), which adds
  // "Authorization: Bearer <token>" while a token is stored. Without a token (loopback default,
  // VS Code webview) requests are plain fetches with no Authorization header, as before.
  var TOKEN_KEY = "codeforge.authToken";
  function readStoredToken() {
    try { var t = sessionStorage.getItem(TOKEN_KEY); return t ? String(t) : ""; } catch (_e) { return ""; }
  }
  function storeToken(t) {
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch (_e) { /* storage unavailable: memory only */ }
  }
  function forgetToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_e) { /* storage unavailable */ }
  }
  var authToken = readStoredToken();

  function authHeaders(extra) {
    var h = {};
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    if (authToken) h["authorization"] = "Bearer " + authToken;
    return h;
  }
  // The single network entry point of the dashboard.
  function api(path, init) {
    var opts = {};
    Object.keys(init || {}).forEach(function (k) { opts[k] = init[k]; });
    opts.headers = authHeaders(opts.headers);
    var sentToken = authToken;
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) onUnauthorized(sentToken);
      return r;
    });
  }
  // A 401 means the server requires a token we do not have (or the stored one is wrong). Clear the
  // stored token and show the entry form. A 401 for a request sent with an OLDER token (or none)
  // than the current one is stale and must not discard a freshly entered token.
  function onUnauthorized(sentToken) {
    if (sentToken !== authToken) return;
    var hadToken = !!authToken;
    if (hadToken) { authToken = ""; forgetToken(); }
    closeStream();
    setStatus("unauthorized");
    $("authStatus").textContent = hadToken
      ? "Access token rejected. Enter a valid token."
      : "This server requires an access token.";
    var form = $("authForm");
    if (form.hidden) {
      form.hidden = false;
      var input = $("authToken");
      if (typeof input.focus === "function") input.focus();
    }
  }
  function submitToken() {
    var input = $("authToken");
    var value = String(input.value || "").trim();
    if (!value) { $("authStatus").textContent = "Enter the access token."; return; }
    authToken = value;
    storeToken(value);
    input.value = "";
    $("authStatus").textContent = "";
    $("authForm").hidden = true;
    // Retry the loads that failed with 401.
    loadConfig();
    refreshModels();
    captureBaseline();
    if ($("session").value.trim()) connect();
  }

  // ── Live stream (/stream) ──
  // No token: EventSource (unchanged loopback behaviour). Token: EventSource cannot send headers and
  // tokens must not go into URLs, so read the SSE body through fetch + a stream reader instead.
  var streamCtl = null;      // AbortController of the active fetch stream
  var reconnectTimer = null; // pending fetch-stream reconnect
  var lastSeq = 0;           // last received SSE id (event sequenceNumber); resume cursor

  function closeStream() {
    if (es) { es.close(); es = null; }
    if (streamCtl) { var c = streamCtl; streamCtl = null; try { c.abort(); } catch (_e) {} }
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function noteSeq(id) {
    var n = Number(id);
    if (id !== null && id !== undefined && id !== "" && isFinite(n)) lastSeq = n;
  }

  function onStreamData(data) {
    try {
      var e = JSON.parse(data);
      // Render the event as a reasoning line (expands MISSION_* payloads into readable thinking).
      var ul = $("activity");
      ul.appendChild(activityItem(e.type, e.at, e.payload));
      ul.scrollTop = ul.scrollHeight;
      refreshState();
    } catch (_e) {}
  }

  function openEventSource(sid) {
    es = new EventSource("/stream?session=" + encodeURIComponent(sid));
    es.onopen = function () { setStatus("connected"); };
    es.onerror = function () { setStatus("stream error"); };
    es.onmessage = function (ev) {
      noteSeq(ev.lastEventId);
      onStreamData(ev.data);
    };
  }

  // One SSE frame (text between blank lines) -> { id, data }. Comment lines (":") are ignored.
  function parseSseFrame(frame) {
    var id = null;
    var data = [];
    frame.split("\\n").forEach(function (line) {
      if (!line || line.charAt(0) === ":") return;
      var c = line.indexOf(":");
      var field = c < 0 ? line : line.slice(0, c);
      var value = c < 0 ? "" : line.slice(c + 1);
      if (value.charAt(0) === " ") value = value.slice(1);
      if (field === "id") id = value;
      else if (field === "data") data.push(value);
    });
    return { id: id, data: data.join("\\n") };
  }

  function openFetchStream(sid) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    // The handle identifies THIS stream; connect()/closeStream() replace or clear it, which
    // stops the pump and suppresses reconnects of a superseded stream.
    var handle = ctl || { abort: function () {} };
    streamCtl = handle;
    function current() { return streamCtl === handle && sid === sessionId && !!authToken; }
    function reconnectLater() {
      if (!current()) return;
      setStatus("stream error");
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        if (current()) openStream(sid);
      }, 2000);
    }
    var init = ctl ? { signal: ctl.signal } : {};
    api("/stream?session=" + encodeURIComponent(sid) + "&from=" + lastSeq, init)
      .then(function (r) {
        if (streamCtl !== handle) return;
        if (r.status === 401) { streamCtl = null; return; } // api() already showed the token form
        if (!r.ok || !r.body) { reconnectLater(); return; }
        setStatus("connected");
        var reader = r.body.getReader();
        var dec = new TextDecoder();
        var buf = "";
        function pump() {
          return reader.read().then(function (chunk) {
            if (streamCtl !== handle) { try { reader.cancel(); } catch (_e) {} return; }
            if (chunk.done) { reconnectLater(); return; }
            buf += dec.decode(chunk.value, { stream: true });
            buf = buf.replace(/\\r\\n?/g, "\\n");
            var idx = buf.indexOf("\\n\\n");
            while (idx >= 0) {
              var f = parseSseFrame(buf.slice(0, idx));
              buf = buf.slice(idx + 2);
              noteSeq(f.id);
              if (f.data) onStreamData(f.data);
              idx = buf.indexOf("\\n\\n");
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () { reconnectLater(); });
  }

  function openStream(sid) {
    if (!authToken) return openEventSource(sid); // unchanged behaviour on loopback
    return openFetchStream(sid);
  }

  // ── Output encoding (P0 security hardening, Requirement 10) ──
  // Every value that comes from the runtime (model output, workspace paths, tool args, session
  // metadata, model names, error strings) is UNTRUSTED. Render it through the DOM: createElement +
  // textContent / setAttribute / DOM properties. escText / escAttr exist only for a renderer that
  // must keep a string template (text vs quoted-attribute context — not one universal escaper).
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function txt(s) { return document.createTextNode(String(s)); }
  // Append a list of children: DOM nodes as-is, anything else as an inert text node.
  function append(parent, items) {
    items.forEach(function (it) {
      if (it === null || it === undefined || it === "") return;
      parent.appendChild(typeof it === "object" ? it : txt(it));
    });
    return parent;
  }
  function escText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return escText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function safeClass(value, allowed, fallback) {
    return Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback;
  }
  function safeUrl(u) {
    var s = String(u).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return /^https?:/i.test(s) ? s : "";
    return s;
  }
  function clear(node) { node.textContent = ""; }
  function muted(text) { var n = el("div", null, text); n.style.color = "#8b949e"; return n; }
  // Class allowlists, built from the CSS in DASHBOARD_HTML. Unknown values get a neutral fallback.
  var TASK_STATE_CLASS = { pending: 1, ready: 1, active: 1, blocked: 1, passed: 1, failed: 1, verifying: 1, superseded: 1 };
  var CHANGE_KIND_CLASS = { edit: 1, write: 1, "delete": 1, move: 1 };
  var GOV_LEVEL_CLASS = { pass: 1, fail: 1, recover: 1, gate: 1, approve: 1, deny: 1 };
  var CHIP_STATUS_CLASS = { queued: 1, running: 1, completed: 1, aborted: 1, failed: 1, awaiting_human: 1 };

  function kv(host, obj) {
    clear(host);
    Object.keys(obj).forEach(function (k) {
      host.appendChild(el("b", null, k));
      host.appendChild(el("span", null, obj[k]));
    });
  }

  function refreshState() {
    if (!sessionId) return;
    api("/state?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) {
        if (!st) { kv($("agentState"), { session: "not found" }); return; }
        kv($("agentState"), {
          session: st.sessionId, state: st.sessionState, graph: "v" + st.graphVersion,
          model: st.model || "-", provider: st.provider || "-",
          tasks: st.counts.total, passed: st.counts.passed, active: st.counts.active,
          blocked: st.counts.blocked, failed: st.counts.failed
        });
        var pct = st.budget ? Math.round(st.budget.pressure * 100) : 0;
        $("budgetBar").style.width = pct + "%";
        $("budgetText").textContent = st.budget ? ("budget pressure " + pct + "%") : "no budget info";
        // When the SESSION is already terminal (COMPLETED/ABORTED/AWAITING_HUMAN), a task left in
        // VERIFYING is NOT still running — it ran but could not be promoted to PASSED (e.g. the
        // workspace has no verification checks, so there is no evidence to pass). Show that
        // honestly as "done (unverified)" instead of a spinning/active state.
        var sessionDone = st.sessionState === "COMPLETED" || st.sessionState === "ABORTED" || st.sessionState === "AWAITING_HUMAN";
        renderTaskGraph(st.tasks, sessionDone);
      });
    refreshApproval();
    refreshResult();
    refreshChanges();
    refreshGovernance();
  }

  // The governance timeline: the runtime's SAFETY events — verification verdicts, failure
  // classifications, recovery actions (RETRY/FIX/REPLAN/ROLLBACK/ESCALATE), completion-gate
  // challenges, and tool approvals/denials. This is the kernel's distinctive value made visible:
  // the agent's output is GOVERNED, not just produced. Reconstructed from /events (no new API).
  // Each governance line is { cls, icon, parts } where parts are DOM nodes or plain text.
  function sub(text) { return el("span", "sub", text); }
  function govLine(e) {
    var p = e.payload || {};
    var t = e.type;
    if (t === "VERIFICATION_ENDED") {
      var ok = p.status === "PASS";
      return { cls: ok ? "pass" : "fail", icon: ok ? "✓" : "✗",
        parts: ["verification ", el("b", null, p.status), " ", sub(p.scope || "")] };
    }
    if (t === "TASK_FAILED" || t === "FAILURE_DETECTED") {
      return { cls: "fail", icon: "⚠", parts: ["failure ", el("b", null, p.class || "UNKNOWN"), " ", sub(p.stage || "")] };
    }
    if (t === "RECOVERY_ACTION_TAKEN" || t === "RECOVERY_ACTION_CHOSEN") {
      return { cls: "recover", icon: "↻",
        parts: ["recovery ", el("b", null, p.action || "?"),
          p.outcome ? " " : "", p.outcome ? sub("→ " + String(p.outcome)) : null,
          p.reason ? " " : "", p.reason ? sub(String(p.reason).slice(0, 80)) : null] };
    }
    if (t === "DECISION_COMPLETED" && typeof p.decision === "string" && p.decision.indexOf("done_rejected") === 0) {
      var why = p.decision === "done_rejected_missing_paths" ? "named files not written" : "no change made";
      return { cls: "gate", icon: "⛔", parts: ["completion gate challenged ", el("b", null, "done"), " ", sub("(" + why + ")")] };
    }
    if (t === "TOOL_CALL_APPROVED") return { cls: "approve", icon: "👍", parts: ["tool call ", el("b", null, "approved"), " ", sub(p.toolCallId || "")] };
    if (t === "TOOL_CALL_DENIED")   return { cls: "deny", icon: "👎", parts: ["tool call ", el("b", null, "denied"), " ", sub(p.toolCallId || "")] };
    if (t === "MISSION_ARCHITECTURE_GATE_BLOCKED") return { cls: "gate", icon: "⛔", parts: ["architecture gate ", el("b", null, "BLOCKED")] };
    return null; // not a governance event
  }
  function refreshGovernance() {
    if (!sessionId) { clear($("governance")); return; }
    api("/events?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (events) {
        var host = $("governance");
        clear(host);
        var count = 0;
        events.forEach(function (e) {
          var g = govLine(e);
          if (!g) return;
          var lvl = safeClass(g.cls, GOV_LEVEL_CLASS, "");
          var row = el("div", lvl ? "gov " + lvl : "gov");
          row.appendChild(el("span", "gi", g.icon));
          row.appendChild(el("span", "gt", String(e.at || "").slice(11, 19)));
          row.appendChild(append(el("span", "gm"), g.parts));
          host.appendChild(row);
          count++;
        });
        if (!count) host.appendChild(muted("(no governance events yet)"));
        host.scrollTop = host.scrollHeight;
      })
      .catch(function () {});
  }

  // The agent's change transcript: each mutating tool call with its reconstructed diff. This is
  // the "what did the agent actually do" view — write_file shows new content, edit_file shows a
  // -old/+new hunk, delete/move a one-line summary.
  function renderDiff(diff) {
    var pre = el("pre");
    String(diff).split("\\n").forEach(function (l, i) {
      if (i > 0) pre.appendChild(txt("\\n"));
      var cls = l.charAt(0) === "+" ? "add" : (l.charAt(0) === "-" ? "del" : "");
      pre.appendChild(el("span", cls, l));
    });
    return pre;
  }
  function refreshChanges() {
    if (!sessionId) { clear($("changes")); return; }
    api("/changes?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : { changes: [] }; })
      .then(function (b) {
        var host = $("changes");
        var changes = (b.changes || []);
        clear(host);
        if (changes.length === 0) { host.appendChild(muted("(no changes yet)")); return; }
        // Newest first — the most recent edit is the most interesting.
        changes.slice().reverse().forEach(function (c) {
          var kind = c.kind == null ? "" : String(c.kind);
          var kcls = safeClass(kind, CHANGE_KIND_CLASS, "");
          var head = el("div", "chd");
          head.appendChild(el("span", kcls ? "k " + kcls : "k", kind));
          head.appendChild(el("span", "p", c.path || c.summary || ""));
          head.appendChild(el("span", "t", String(c.state == null ? "" : c.state) + " · " + String(c.at || "").slice(11, 19)));
          var box = el("div", "change");
          box.appendChild(head);
          if (c.diff) box.appendChild(renderDiff(c.diff));
          host.appendChild(box);
        });
      })
      .catch(function () {});
  }

  // Map a task projection to a CSS state class for the graph node (mirrors the old list marks).
  function taskClass(t, sessionDone) {
    if (sessionDone && t.state === "VERIFYING") return "passed"; // done, unverified (no checks)
    if (t.isActive || t.state === "RUNNING") return "active";
    if (t.state === "PASSED") return "passed";
    if (t.state === "FAILED" || t.state === "TIMEOUT") return "failed";
    if (t.state === "VERIFYING") return "verifying";
    if (t.state === "SUPERSEDED") return "superseded";
    if (t.isBlocked) return "blocked";
    if (t.state === "READY") return "ready";
    return "pending";
  }

  // Render the task graph as an SVG DAG: nodes laid out in dependency LAYERS (a node sits one row
  // below its deepest dependency), edges = depends_on. Pure layout from /state (TaskProjection
  // carries dependsOn); no backend change. Degrades to "(no tasks)" when empty.
  function renderTaskGraph(tasks, sessionDone) {
    var host = $("taskGraph");
    clear(host);
    if (!tasks || tasks.length === 0) { host.appendChild(muted("(no tasks)")); return; }
    tasks = tasks.map(function (t) {
      // Normalise ids to strings so layout keys and labels never depend on payload types.
      var deps = Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [];
      return { taskId: String(t.taskId), state: t.state, isActive: t.isActive, isBlocked: t.isBlocked, dependsOn: deps };
    });

    var byId = {};
    tasks.forEach(function (t) { byId[t.taskId] = t; });

    // Longest-path layer per node (memoized DFS; tolerant of cycles via a visiting guard).
    var layer = {}, visiting = {};
    function depthOf(id) {
      if (layer[id] !== undefined) return layer[id];
      if (visiting[id]) return 0; // cycle guard — treat as root
      visiting[id] = true;
      var deps = (byId[id] && byId[id].dependsOn) || [];
      var d = 0;
      deps.forEach(function (p) { if (byId[p]) d = Math.max(d, depthOf(p) + 1); });
      visiting[id] = false;
      layer[id] = d;
      return d;
    }
    tasks.forEach(function (t) { depthOf(t.taskId); });

    // Group nodes by layer (deterministic order within a layer).
    var rows = {};
    tasks.forEach(function (t) { (rows[layer[t.taskId]] = rows[layer[t.taskId]] || []).push(t); });
    var layers = Object.keys(rows).map(Number).sort(function (a, b) { return a - b; });
    layers.forEach(function (L) { rows[L].sort(function (a, b) { return a.taskId < b.taskId ? -1 : 1; }); });

    // Geometry.
    var NW = 150, NH = 38, GAPX = 26, GAPY = 34, PADX = 12, PADY = 12;
    var pos = {}; // taskId -> {x,y}
    var maxCols = 0;
    layers.forEach(function (L, ri) {
      rows[L].forEach(function (t, ci) {
        pos[t.taskId] = { x: PADX + ci * (NW + GAPX), y: PADY + ri * (NH + GAPY) };
      });
      maxCols = Math.max(maxCols, rows[L].length);
    });
    var width = PADX * 2 + maxCols * NW + (maxCols - 1) * GAPX;
    var height = PADY * 2 + layers.length * NH + (layers.length - 1) * GAPY;

    // SVG built through the DOM: geometry is numeric, classes come from the allowlist, labels
    // are textContent. No runtime value is ever parsed as markup.
    var SVGNS = "http://www.w3.org/2000/svg";
    function svg(tag, attrs, text) {
      var n = document.createElementNS(SVGNS, tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
      if (text !== undefined) n.textContent = String(text);
      return n;
    }
    var root = svg("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height });
    var defs = svg("defs");
    var marker = svg("marker", { id: "arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" });
    marker.appendChild(svg("path", { d: "M0 0 L8 4 L0 8 z", fill: "#30363d" }));
    defs.appendChild(marker);
    root.appendChild(defs);

    // Edges (depends_on): dependency (top) -> dependent (bottom).
    tasks.forEach(function (t) {
      t.dependsOn.forEach(function (p) {
        if (!pos[p] || !pos[t.taskId]) return;
        var x1 = pos[p].x + NW / 2, y1 = pos[p].y + NH;
        var x2 = pos[t.taskId].x + NW / 2, y2 = pos[t.taskId].y;
        var my = (y1 + y2) / 2;
        root.appendChild(svg("path", { "class": "edge", "marker-end": "url(#arrow)",
          d: "M" + x1 + " " + y1 + " C" + x1 + " " + my + " " + x2 + " " + my + " " + x2 + " " + y2 }));
      });
    });

    // Nodes.
    tasks.forEach(function (t) {
      var p = pos[t.taskId]; if (!p) return;
      var cls = safeClass(taskClass(t, sessionDone), TASK_STATE_CLASS, "pending");
      var shortId = t.taskId.length > 18 ? t.taskId.slice(0, 17) + "…" : t.taskId;
      var stLabel = (sessionDone && t.state === "VERIFYING") ? "done (unverified)" : String(t.state == null ? "" : t.state);
      var g = svg("g", { "class": "node " + cls });
      g.appendChild(svg("rect", { x: p.x, y: p.y, width: NW, height: NH }));
      g.appendChild(svg("text", { x: p.x + 8, y: p.y + 15 }, shortId));
      g.appendChild(svg("text", { "class": "st", x: p.x + 8, y: p.y + 29 }, stLabel));
      root.appendChild(g);
    });

    host.appendChild(root);
  }

  // Approval: when a tool call is APPROVAL_PENDING the agent is BLOCKED at AWAITING_HUMAN until a
  // decision is made. Make it impossible to miss — a pulsing top-of-page banner that names WHAT
  // the agent wants to do (tool + path/command + risk), not just the opaque toolCallId. Details
  // come from /changes (the per-session tool-call list we already serve); if that lookup fails we
  // still show the id so the decision is never blocked. Also mirrors into the small Control panel.
  function hideApprovalBanner() {
    $("approvalBanner").className = "";
    $("approval").textContent = "none";
  }
  function showApprovalBanner(pending, detailParts) {
    var detail = $("abDetail");
    clear(detail);
    append(detail, detailParts);
    $("approvalBanner").className = "show";
    $("approval").innerHTML = "<b>1 pending</b> — see the banner at the top";
    // Rebind buttons each render (re-rendering the detail doesn't touch the buttons, but the pending
    // id changes, so re-wire with the current id).
    $("abApprove").onclick = function () { decideTool("approve", pending); };
    $("abDeny").onclick = function () { decideTool("deny", pending); };
  }
  function bareApprovalDetail(pending) {
    return ["Tool call ", el("code", null, pending), " is awaiting your decision."];
  }
  function refreshApproval() {
    if (!sessionId) { hideApprovalBanner(); return; }
    api("/events?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (events) {
        var pending = null;
        events.forEach(function (e) {
          var p = e.payload || {};
          if (e.type === "TOOL_CALL_REQUESTED" && p.state === "APPROVAL_PENDING") pending = p.toolCallId;
          // Any resolution of that id clears it.
          if (p.toolCallId && pending === p.toolCallId &&
              (e.type === "TOOL_CALL_APPROVED" || e.type === "TOOL_CALL_DENIED" ||
               e.type === "TOOL_CALL_STARTED" || e.type === "TOOL_CALL_ENDED")) {
            pending = null;
          }
        });
        if (!pending) { hideApprovalBanner(); return; }
        // Enrich with the tool details from /changes (toolName/kind/path/summary) so the human sees
        // exactly what will run. Fail-safe: on any error, fall back to the bare id.
        api("/changes?session=" + encodeURIComponent(sessionId))
          .then(function (r) { return r.ok ? r.json() : { changes: [] }; })
          .then(function (b) {
            var c = (b.changes || []).filter(function (x) { return x.toolCallId === pending; })[0];
            var detail;
            if (c) {
              var what = c.summary || (String(c.toolName) + (c.path ? " " + String(c.path) : ""));
              var info = el("div");
              info.style.marginTop = "6px";
              info.style.color = "#8b949e";
              append(info, [String(what) + " · ", el("code", null, pending)]);
              detail = ["The agent wants to run ", el("code", null, c.toolName || c.kind),
                c.path ? " on " : "", c.path ? el("code", null, c.path) : null,
                el("span", "ab-risk", "needs approval"), info];
            } else {
              detail = bareApprovalDetail(pending);
            }
            showApprovalBanner(pending, detail);
          })
          .catch(function () { showApprovalBanner(pending, bareApprovalDetail(pending)); });
      })
      .catch(function () {});
  }

  function decideTool(intent, toolCallId) {
    api("/control", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: intent, sessionId: sessionId, toolCallId: toolCallId,
        requestedBy: { kind: "user", id: "dashboard", surface: "dashboard" } })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var ok = res.admission && res.admission.admitted;
        $("controlResult").textContent = intent + " tool: " + (ok ? "admitted" : "rejected (" + (res.admission && res.admission.reason) + ")");
        refreshState(); refreshApproval();
      })
      .catch(function (e) { $("controlResult").textContent = intent + ": error " + e; });
  }

  // Show the tangible RESULT: the files currently in the workspace (what the agent produced).
  // The runtime has one workspace, so this reflects the latest run's effect.
  function refreshResult() {
    api("/workspace/files")
      .then(function (r) { return r.ok ? r.json() : { files: [] }; })
      .then(function (b) {
        var files = b.files || [];
        $("resultSummary").textContent = files.length
          ? (files.length + " file(s) in the workspace")
          : "no files yet (agent has not written anything, or workspace is empty)";
        var list = $("files");
        clear(list);
        files.forEach(function (f) {
          var size = Number(f.sizeBytes);
          var li = el("li", null, String(f.path) + " ");
          li.appendChild(el("span", "cat", (isFinite(size) ? size : "?") + " B"));
          list.appendChild(li);
        });
      })
      .catch(function () {});
  }

  // Turn a raw DomainEvent into a human-readable "reasoning" line (commercial-agent style). The
  // MISSION_* events carry the agent's thinking in their payload; render it, not just the type.
  // Returns the line's parts (DOM nodes / plain text), or null to render the plain type.
  function str(x) { return x === null || x === undefined ? "" : String(x); }
  function joinList(x, sep) { return Array.isArray(x) ? x.map(str).join(sep) : str(x); }
  function subList(items) { return items.length ? append(el("ul", "reasoning-sub"), items) : null; }
  function reasoningLine(type, p) {
    p = p || {};
    switch (type) {
      case "MISSION_RECEIVED":            return ["🧠 received goal: " + str(p.description)];
      case "MISSION_CLASSIFIED":          return ["🧠 classified as ", el("b", null, str(p.missionType)), p.matchedKeyword ? " (" + str(p.matchedKeyword) + ")" : ""];
      case "MISSION_COMPLEXITY_ESTIMATED":return ["🧠 complexity ", el("b", null, str(p.level)), p.reasons && p.reasons.length ? " — " + joinList(p.reasons, ", ") : ""];
      case "MISSION_RISK_ASSESSED":       return ["🧠 risk ", el("b", null, str(p.level)), p.factors && p.factors.length ? " (" + joinList(p.factors, ", ") + ")" : ""];
      case "MISSION_UNCERTAINTY_ASSESSED": {
        var q = (Array.isArray(p.openQuestions) ? p.openQuestions : []).map(function (x) { return el("li", null, str(x)); });
        return ["🧠 goal clarity: ", el("b", null, str(p.level)), subList(q)];
      }
      case "MISSION_ASSUMPTIONS_MADE": {
        var items = (Array.isArray(p.assumptions) ? p.assumptions : []).map(function (a) {
          a = a || {};
          return append(el("li"), [el("b", null, str(a.assumption)),
            a.acceptance ? " " : "", a.acceptance ? el("span", "cat", "✓ " + str(a.acceptance)) : null]);
        });
        return ["💡 made assumptions (goal was under-specified): ", el("i", null, str(p.clarifiedGoal)), subList(items)];
      }
      case "MISSION_MODEL_SELECTED":          return ["🧠 model: ", el("b", null, str(p.modelId || p.kind)), p.reason ? " — " + str(p.reason) : ""];
      case "MISSION_PLANNING_MODE_SELECTED":  return ["🧠 planning mode: ", el("b", null, str(p.mode))];
      case "MISSION_ARCHITECTURE_PROPOSED":   return ["🧠 proposed architecture: " + str(p.summary)];
      case "MISSION_ARCHITECTURE_GATE_BLOCKED": return ["⛔ architecture gate BLOCKED: " + joinList(p.blockers || [], "; ")];
      case "MISSION_CAPABILITY_VERIFIED":     return ["✓ capability verified: ", el("b", null, str(p.name)), p.version ? " " + str(p.version) : ""];
      default: return null;
    }
  }

  // One <li> for the Live Activity list, built through the DOM (time and type are text).
  function activityItem(type, at, payload) {
    var reasoning = reasoningLine(type, payload);
    var time = str(at).slice(11, 19);
    if (reasoning) return append(el("li", "reasoning"), [time + " "].concat(reasoning));
    return append(el("li"), [time + " ", el("span", "cat", str(type))]);
  }

  function renderActivity(events) {
    // The /trace endpoint returns {category,eventType}; the raw event stream returns {type,payload}.
    var ul = $("activity");
    clear(ul);
    events.slice(-200).forEach(function (e) {
      var type = e.type || e.eventType;
      ul.appendChild(activityItem(type, e.at, e.payload));
    });
    ul.scrollTop = ul.scrollHeight;
  }

  function connect() {
    sessionId = $("session").value.trim();
    if (!sessionId) return;
    closeStream(); // aborts a previous fetch stream / closes a previous EventSource
    lastSeq = 0;
    refreshState();
    api("/trace?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : { entries: [] }; })
      .then(function (t) { renderActivity(t.entries || []); })
      .catch(function () {});
    openStream(sessionId);
  }

  function sendControl(intent) {
    if (!sessionId) return;
    api("/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: intent, sessionId: sessionId, requestedBy: { kind: "user", id: "dashboard", surface: "dashboard" } })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var ok = res.admission && res.admission.admitted;
        $("controlResult").textContent = intent + ": " + (ok ? "admitted (" + res.record.result + ")" : "rejected (" + (res.admission && res.admission.reason) + ")");
        refreshState();
      })
      .catch(function (e) { $("controlResult").textContent = intent + ": error " + e; });
  }

  // ── Goals chat: a persistent history of submitted goals, each tracked to its session. ──
  // The goal queue is sequential (one session at a time), so a submitted goal may wait in the
  // queue before its session starts. We NEVER drop the text: every goal becomes a chat entry
  // whose status chip updates (queued → running → completed/aborted/awaiting_human) as the
  // worker picks it up and the session progresses. Sessions are bound to goals in FIFO order.
  var goals = [];        // { localId, text, at, sessionId, status }
  var boundSessions = {}; // sessionId -> true once attached to a goal
  var nextLocalId = 1;

  function statusClass(s) { return safeClass(String(s || "queued").toLowerCase(), CHIP_STATUS_CLASS, ""); }

  function renderChat() {
    var log = $("chatLog");
    clear(log);
    goals.forEach(function (g) {
      var sess;
      if (g.sessionId) {
        var sid = String(g.sessionId);
        sess = el("a", "view", "view session " + sid.slice(0, 8));
        sess.setAttribute("data-sid", sid);
        // Attach the view link's listener directly (attach activity panel to that session).
        sess.addEventListener("click", function () { $("session").value = sid; connect(); });
      } else {
        sess = el("span", null, "waiting in queue…");
      }
      var sc = statusClass(g.status);
      var meta = el("div", "meta");
      meta.appendChild(el("span", sc ? "chip " + sc : "chip", str(g.status)));
      meta.appendChild(el("span", null, str(g.at).slice(11, 19)));
      meta.appendChild(sess);
      var msg = el("div", "msg");
      msg.appendChild(el("div", "goalText", g.text));
      msg.appendChild(meta);
      log.appendChild(msg);
    });
    log.scrollTop = log.scrollHeight;
  }

  function submitGoal() {
    var desc = $("goalInput").value.trim();
    if (!desc) return;
    var entry = { localId: nextLocalId++, text: desc, at: new Date().toISOString(), sessionId: null, status: "queued" };
    goals.push(entry);
    $("goalInput").value = "";
    renderChat();
    api("/goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: desc })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) { entry.status = "failed"; entry.text += "\\n[error: " + (res.body && res.body.error) + "]"; renderChat(); }
        // else: stays queued until the poller binds a session to it.
      })
      .catch(function (e) { entry.status = "failed"; entry.text += "\\n[error: " + e + "]"; renderChat(); });
  }

  // Ignore every session that already existed before THIS dashboard session started, so a
  // freshly-submitted goal only ever binds to a genuinely new session (not a prior run).
  var baselineCaptured = false;
  function captureBaseline() {
    return api("/sessions?limit=50")
      .then(function (r) { return r.ok ? r.json() : { sessions: [] }; })
      .then(function (b) { (b.sessions || []).forEach(function (s) { boundSessions[s.sessionId] = true; }); baselineCaptured = true; })
      .catch(function () { baselineCaptured = true; });
  }

  // One poller binds new sessions to queued goals (FIFO) and refreshes each goal's status.
  function pollGoals() {
    if (!baselineCaptured || goals.length === 0) return;
    api("/sessions?limit=50")
      .then(function (r) { return r.ok ? r.json() : { sessions: [] }; })
      .then(function (b) {
        var sessions = (b.sessions || []); // newest first
        // Bind: for each unbound session (oldest first), attach to the oldest still-queued goal.
        var ascending = sessions.slice().reverse();
        ascending.forEach(function (s) {
          if (boundSessions[s.sessionId]) return;
          var g = goals.find(function (x) { return x.sessionId === null; });
          if (!g) return;
          g.sessionId = s.sessionId;
          g.status = s.state;
          boundSessions[s.sessionId] = true;
        });
        // Refresh status of already-bound goals from the current session list.
        var byId = {};
        sessions.forEach(function (s) { byId[s.sessionId] = s.state; });
        goals.forEach(function (g) { if (g.sessionId && byId[g.sessionId]) g.status = byId[g.sessionId]; });
        renderChat();
      })
      .catch(function () {});
  }

  function humanBytes(n) {
    if (!n && n !== 0) return "";
    var u = ["B", "KB", "MB", "GB", "TB"]; var i = 0; var v = Number(n);
    if (!isFinite(v)) return "";
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + " " + u[i];
  }

  var activeModel = "";

  function loadConfig() {
    api("/config")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg) return;
        activeModel = cfg.model || "";
        $("workspace").textContent = "workspace: " + (cfg.workspaceRoot || "—");
        $("workspace").title = cfg.workspaceRoot || "";
        syncModelSelect();
      })
      .catch(function () {});
  }

  var modelNames = [];
  function syncModelSelect() {
    var sel = $("modelSelect");
    var opts = modelNames.slice();
    if (activeModel && opts.indexOf(activeModel) < 0) opts.unshift(activeModel);
    clear(sel);
    function option(value, label, selected) {
      var o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      if (selected) o.selected = true;
      sel.appendChild(o);
    }
    opts.forEach(function (n) { option(str(n), str(n), n === activeModel); });
    if (opts.length === 0) option("", "—", false);
  }

  function refreshModels() {
    var list = $("models");
    api("/models")
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        clear(list);
        if (!res.ok) { list.appendChild(el("li", null, (res.body && res.body.error) || "model admin unavailable")); return; }
        var models = (res.body && res.body.models) || [];
        modelNames = models.map(function (m) { return m.name; });
        syncModelSelect();
        if (models.length === 0) { list.appendChild(el("li", null, "(no models installed)")); return; }
        models.forEach(function (m) {
          var meta = [m.parameterSize, m.quantization, humanBytes(m.sizeBytes)].filter(Boolean).map(str).join(" · ");
          var li = el("li", null, str(m.name));
          if (meta) append(li, [" ", el("span", "cat", meta)]);
          if (m.name === activeModel) append(li, [" ", el("span", "chip running", "active")]);
          list.appendChild(li);
        });
      })
      .catch(function (e) { clear(list); list.appendChild(el("li", null, "error " + e)); });
  }

  function switchModel(name) {
    if (!name || name === activeModel) return;
    api("/config/model", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (res.ok) { activeModel = res.body.model; refreshModels(); }
      })
      .catch(function () {});
  }

  var pullSource = null;
  function pullModel() {
    var name = $("pullInput").value.trim();
    if (!name) return;
    if (pullSource) { pullSource.close(); pullSource = null; }
    $("pullStatus").textContent = "starting download of " + name + " ...";
    $("pullBar").style.width = "0%";
    // POST that returns an SSE stream: use fetch + manual reader (EventSource is GET-only).
    api("/models/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name })
    }).then(function (res) {
      if (res.status === 401) { $("pullStatus").textContent = "unauthorized: enter the access token"; return; }
      if (!res.ok || !res.body) { $("pullStatus").textContent = "pull failed to start"; return; }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { refreshModels(); return; }
          buf += dec.decode(r.value, { stream: true });
          var idx = buf.indexOf("\\n\\n");
          while (idx >= 0) {
            var frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            var line = frame.replace(/^data: /, "").trim();
            if (line) {
              try {
                var p = JSON.parse(line);
                if (p.error) { $("pullStatus").textContent = "error: " + p.error; }
                else {
                  var pct = (typeof p.percent === "number") ? p.percent : null;
                  if (pct !== null) $("pullBar").style.width = pct + "%";
                  $("pullStatus").textContent = p.status + (pct !== null ? " (" + pct + "%)" : "");
                }
                if (p.done) { $("pullBar").style.width = "100%"; refreshModels(); }
              } catch (_e) {}
            }
            idx = buf.indexOf("\\n\\n");
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) { $("pullStatus").textContent = "error " + e; });
  }

  $("connect").addEventListener("click", connect);
  $("authForm").addEventListener("submit", function (ev) { ev.preventDefault(); submitToken(); });
  Array.prototype.forEach.call(document.querySelectorAll(".controls button[data-intent]"), function (b) {
    b.addEventListener("click", function () { sendControl(b.getAttribute("data-intent")); });
  });
  // Chat: submit on form submit (button) and on Enter (Shift+Enter inserts a newline).
  $("chatForm").addEventListener("submit", function (ev) { ev.preventDefault(); submitGoal(); });
  $("goalInput").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submitGoal(); }
  });
  $("pullBtn").addEventListener("click", pullModel);
  $("refreshModels").addEventListener("click", refreshModels);
  $("modelSelect").addEventListener("change", function () { switchModel($("modelSelect").value); });
  loadConfig();
  refreshModels();
  captureBaseline();
  setInterval(pollGoals, 1500);
  setInterval(loadConfig, 5000);
})();`;
