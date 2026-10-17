// Dashboard assets (P9.3) — a minimal, framework-free static client served by
// HttpTransport. It is a pure CONSUMER: it renders the RuntimeProjection + ActivityTrace
// and sends ControlRequests to POST /control. It holds no authoritative state (OB-005)
// and reaches the kernel only through the admitted control path (OB-006).
//
// Kept as inline string constants so the server has nothing to read from disk (zero file
// I/O, easy to package). Strict: no external scripts, no inline event handlers in HTML
// (handlers are attached in app.js), no secrets.

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

  function kv(obj) {
    var html = "";
    Object.keys(obj).forEach(function (k) {
      html += "<b>" + k + "</b><span>" + String(obj[k]) + "</span>";
    });
    return html;
  }

  function refreshState() {
    if (!sessionId) return;
    fetch("/state?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) {
        if (!st) { $("agentState").innerHTML = "<b>session</b><span>not found</span>"; return; }
        $("agentState").innerHTML = kv({
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
  function govLine(e) {
    var p = e.payload || {};
    var t = e.type;
    if (t === "VERIFICATION_ENDED") {
      var ok = p.status === "PASS";
      return { cls: ok ? "pass" : "fail", icon: ok ? "✓" : "✗",
        html: "verification <b>" + esc2(p.status) + "</b> <span class='sub'>" + esc2(p.scope || "") + "</span>" };
    }
    if (t === "TASK_FAILED" || t === "FAILURE_DETECTED") {
      return { cls: "fail", icon: "⚠", html: "failure <b>" + esc2(p.class || "UNKNOWN") + "</b> <span class='sub'>" + esc2(p.stage || "") + "</span>" };
    }
    if (t === "RECOVERY_ACTION_TAKEN" || t === "RECOVERY_ACTION_CHOSEN") {
      return { cls: "recover", icon: "↻",
        html: "recovery <b>" + esc2(p.action || "?") + "</b>" + (p.outcome ? " <span class='sub'>→ " + esc2(p.outcome) + "</span>" : "") +
          (p.reason ? " <span class='sub'>" + esc2(String(p.reason).slice(0, 80)) + "</span>" : "") };
    }
    if (t === "DECISION_COMPLETED" && typeof p.decision === "string" && p.decision.indexOf("done_rejected") === 0) {
      var why = p.decision === "done_rejected_missing_paths" ? "named files not written" : "no change made";
      return { cls: "gate", icon: "⛔", html: "completion gate challenged <b>done</b> <span class='sub'>(" + why + ")</span>" };
    }
    if (t === "TOOL_CALL_APPROVED") return { cls: "approve", icon: "👍", html: "tool call <b>approved</b> <span class='sub'>" + esc2(p.toolCallId || "") + "</span>" };
    if (t === "TOOL_CALL_DENIED")   return { cls: "deny", icon: "👎", html: "tool call <b>denied</b> <span class='sub'>" + esc2(p.toolCallId || "") + "</span>" };
    if (t === "MISSION_ARCHITECTURE_GATE_BLOCKED") return { cls: "gate", icon: "⛔", html: "architecture gate <b>BLOCKED</b>" };
    return null; // not a governance event
  }
  function refreshGovernance() {
    if (!sessionId) { $("governance").innerHTML = ""; return; }
    fetch("/events?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (events) {
        var rows = [];
        events.forEach(function (e) {
          var g = govLine(e);
          if (g) rows.push("<div class='gov " + g.cls + "'><span class='gi'>" + g.icon + "</span>" +
            "<span class='gt'>" + esc2((e.at || "").slice(11, 19)) + "</span>" +
            "<span class='gm'>" + g.html + "</span></div>");
        });
        $("governance").innerHTML = rows.length ? rows.join("") : "<div style='color:#8b949e'>(no governance events yet)</div>";
        var el = $("governance"); el.scrollTop = el.scrollHeight;
      })
      .catch(function () {});
  }

  // The agent's change transcript: each mutating tool call with its reconstructed diff. This is
  // the "what did the agent actually do" view — write_file shows new content, edit_file shows a
  // -old/+new hunk, delete/move a one-line summary.
  function renderDiff(diff) {
    return diff.split("\\n").map(function (l) {
      var cls = l.charAt(0) === "+" ? "add" : (l.charAt(0) === "-" ? "del" : "");
      return "<span class='" + cls + "'>" + esc2(l) + "</span>";
    }).join("\\n");
  }
  function refreshChanges() {
    if (!sessionId) { $("changes").innerHTML = ""; return; }
    fetch("/changes?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : { changes: [] }; })
      .then(function (b) {
        var changes = (b.changes || []);
        if (changes.length === 0) { $("changes").innerHTML = "<div style='color:#8b949e'>(no changes yet)</div>"; return; }
        // Newest first — the most recent edit is the most interesting.
        $("changes").innerHTML = changes.slice().reverse().map(function (c) {
          var head =
            "<div class='chd'><span class='k " + esc2(c.kind) + "'>" + esc2(c.kind) + "</span>" +
            "<span class='p'>" + esc2(c.path || c.summary) + "</span>" +
            "<span class='t'>" + esc2(c.state) + " · " + esc2((c.at || "").slice(11, 19)) + "</span></div>";
          var body = c.diff ? "<pre>" + renderDiff(c.diff) + "</pre>" : "";
          return "<div class='change'>" + head + body + "</div>";
        }).join("");
      })
      .catch(function () {});
  }

  function gesc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

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
    if (!tasks || tasks.length === 0) { host.innerHTML = "<div style='color:#8b949e'>(no tasks)</div>"; return; }

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

    // Edges (depends_on): dependency (top) -> dependent (bottom).
    var edgesSvg = "";
    tasks.forEach(function (t) {
      ((t.dependsOn) || []).forEach(function (p) {
        if (!pos[p] || !pos[t.taskId]) return;
        var x1 = pos[p].x + NW / 2, y1 = pos[p].y + NH;
        var x2 = pos[t.taskId].x + NW / 2, y2 = pos[t.taskId].y;
        var my = (y1 + y2) / 2;
        edgesSvg += "<path class='edge' d='M" + x1 + " " + y1 + " C" + x1 + " " + my + " " + x2 + " " + my + " " + x2 + " " + y2 + "' marker-end='url(#arrow)'/>";
      });
    });

    // Nodes.
    var nodesSvg = tasks.map(function (t) {
      var p = pos[t.taskId]; if (!p) return "";
      var cls = taskClass(t, sessionDone);
      var shortId = t.taskId.length > 18 ? t.taskId.slice(0, 17) + "…" : t.taskId;
      var stLabel = (sessionDone && t.state === "VERIFYING") ? "done (unverified)" : t.state;
      return "<g class='node " + cls + "'>" +
        "<rect x='" + p.x + "' y='" + p.y + "' width='" + NW + "' height='" + NH + "'/>" +
        "<text x='" + (p.x + 8) + "' y='" + (p.y + 15) + "'>" + gesc(shortId) + "</text>" +
        "<text class='st' x='" + (p.x + 8) + "' y='" + (p.y + 29) + "'>" + gesc(stLabel) + "</text>" +
      "</g>";
    }).join("");

    host.innerHTML =
      "<svg width='" + width + "' height='" + height + "' viewBox='0 0 " + width + " " + height + "'>" +
      "<defs><marker id='arrow' viewBox='0 0 8 8' refX='7' refY='4' markerWidth='6' markerHeight='6' orient='auto'>" +
      "<path d='M0 0 L8 4 L0 8 z' fill='#30363d'/></marker></defs>" +
      edgesSvg + nodesSvg + "</svg>";
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
  function showApprovalBanner(pending, detailHtml) {
    $("abDetail").innerHTML = detailHtml;
    $("approvalBanner").className = "show";
    $("approval").innerHTML = "<b>1 pending</b> — see the banner at the top";
    // Rebind buttons each render (innerHTML of detail doesn't touch the buttons, but the pending
    // id changes, so re-wire with the current id).
    $("abApprove").onclick = function () { decideTool("approve", pending); };
    $("abDeny").onclick = function () { decideTool("deny", pending); };
  }
  function refreshApproval() {
    if (!sessionId) { hideApprovalBanner(); return; }
    fetch("/events?session=" + encodeURIComponent(sessionId))
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
        fetch("/changes?session=" + encodeURIComponent(sessionId))
          .then(function (r) { return r.ok ? r.json() : { changes: [] }; })
          .then(function (b) {
            var c = (b.changes || []).filter(function (x) { return x.toolCallId === pending; })[0];
            var detail;
            if (c) {
              var what = c.summary || (c.toolName + (c.path ? " " + c.path : ""));
              detail = "The agent wants to run <code>" + esc2(c.toolName || c.kind) + "</code>" +
                (c.path ? " on <code>" + esc2(c.path) + "</code>" : "") +
                "<span class='ab-risk'>needs approval</span>" +
                "<div style='margin-top:6px;color:#8b949e'>" + esc2(what) + " · <code>" + esc2(pending) + "</code></div>";
            } else {
              detail = "Tool call <code>" + esc2(pending) + "</code> is awaiting your decision.";
            }
            showApprovalBanner(pending, detail);
          })
          .catch(function () { showApprovalBanner(pending, "Tool call <code>" + esc2(pending) + "</code> is awaiting your decision."); });
      })
      .catch(function () {});
  }

  function decideTool(intent, toolCallId) {
    fetch("/control", {
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
    fetch("/workspace/files")
      .then(function (r) { return r.ok ? r.json() : { files: [] }; })
      .then(function (b) {
        var files = b.files || [];
        $("resultSummary").textContent = files.length
          ? (files.length + " file(s) in the workspace")
          : "no files yet (agent has not written anything, or workspace is empty)";
        $("files").innerHTML = files.map(function (f) {
          return "<li>" + f.path + " <span class='cat'>" + f.sizeBytes + " B</span></li>";
        }).join("");
      })
      .catch(function () {});
  }

  function esc2(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // Turn a raw DomainEvent into a human-readable "reasoning" line (commercial-agent style). The
  // MISSION_* events carry the agent's thinking in their payload; render it, not just the type.
  // Returns an HTML string for one <li>, or "" to render the plain type.
  function reasoningLine(type, p) {
    p = p || {};
    switch (type) {
      case "MISSION_RECEIVED":            return "🧠 received goal: " + esc2(p.description);
      case "MISSION_CLASSIFIED":          return "🧠 classified as <b>" + esc2(p.missionType) + "</b>" + (p.matchedKeyword ? " (" + esc2(p.matchedKeyword) + ")" : "");
      case "MISSION_COMPLEXITY_ESTIMATED":return "🧠 complexity <b>" + esc2(p.level) + "</b>" + (p.reasons && p.reasons.length ? " — " + esc2(p.reasons.join(", ")) : "");
      case "MISSION_RISK_ASSESSED":       return "🧠 risk <b>" + esc2(p.level) + "</b>" + (p.factors && p.factors.length ? " (" + esc2(p.factors.join(", ")) + ")" : "");
      case "MISSION_UNCERTAINTY_ASSESSED": {
        var q = (p.openQuestions || []).map(function (x) { return "<li>" + esc2(x) + "</li>"; }).join("");
        return "🧠 goal clarity: <b>" + esc2(p.level) + "</b>" + (q ? "<ul class='reasoning-sub'>" + q + "</ul>" : "");
      }
      case "MISSION_ASSUMPTIONS_MADE": {
        var head = "💡 made assumptions (goal was under-specified): <i>" + esc2(p.clarifiedGoal) + "</i>";
        var items = (p.assumptions || []).map(function (a) {
          return "<li><b>" + esc2(a.assumption) + "</b>" + (a.acceptance ? " <span class='cat'>✓ " + esc2(a.acceptance) + "</span>" : "") + "</li>";
        }).join("");
        return head + (items ? "<ul class='reasoning-sub'>" + items + "</ul>" : "");
      }
      case "MISSION_MODEL_SELECTED":          return "🧠 model: <b>" + esc2(p.modelId || p.kind) + "</b>" + (p.reason ? " — " + esc2(p.reason) : "");
      case "MISSION_PLANNING_MODE_SELECTED":  return "🧠 planning mode: <b>" + esc2(p.mode) + "</b>";
      case "MISSION_ARCHITECTURE_PROPOSED":   return "🧠 proposed architecture: " + esc2(p.summary);
      case "MISSION_ARCHITECTURE_GATE_BLOCKED": return "⛔ architecture gate BLOCKED: " + esc2((p.blockers || []).join("; "));
      case "MISSION_CAPABILITY_VERIFIED":     return "✓ capability verified: <b>" + esc2(p.name) + "</b>" + (p.version ? " " + esc2(p.version) : "");
      default: return "";
    }
  }

  function activityHtml(type, at, payload) {
    var reasoning = reasoningLine(type, payload);
    var time = (at || "").slice(11, 19);
    if (reasoning) return "<li class='reasoning'>" + time + " " + reasoning + "</li>";
    return "<li>" + time + " <span class='cat'>" + esc2(type) + "</span></li>";
  }

  function renderActivity(events) {
    // The /trace endpoint returns {category,eventType}; the raw event stream returns {type,payload}.
    $("activity").innerHTML = events.slice(-200).map(function (e) {
      var type = e.type || e.eventType;
      return activityHtml(type, e.at, e.payload);
    }).join("");
    var ul = $("activity"); ul.scrollTop = ul.scrollHeight;
  }

  function connect() {
    sessionId = $("session").value.trim();
    if (!sessionId) return;
    if (es) { es.close(); es = null; }
    refreshState();
    fetch("/trace?session=" + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (t) { renderActivity(t.entries || []); });

    es = new EventSource("/stream?session=" + encodeURIComponent(sessionId));
    es.onopen = function () { setStatus("connected"); };
    es.onerror = function () { setStatus("stream error"); };
    es.onmessage = function (ev) {
      try {
        var e = JSON.parse(ev.data);
        // Render the event as a reasoning line (expands MISSION_* payloads into readable thinking).
        $("activity").insertAdjacentHTML("beforeend", activityHtml(e.type, e.at, e.payload));
        var ul = $("activity"); ul.scrollTop = ul.scrollHeight;
        refreshState();
      } catch (_e) {}
    };
  }

  function sendControl(intent) {
    if (!sessionId) return;
    fetch("/control", {
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

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function statusClass(s) { return String(s || "queued").toLowerCase(); }

  function renderChat() {
    var log = $("chatLog");
    log.innerHTML = goals.map(function (g) {
      var sess = g.sessionId
        ? "<a class='view' data-sid='" + g.sessionId + "'>view session " + g.sessionId.slice(0, 8) + "</a>"
        : "<span>waiting in queue…</span>";
      return "<div class='msg'>" +
        "<div class='goalText'>" + esc(g.text) + "</div>" +
        "<div class='meta'><span class='chip " + statusClass(g.status) + "'>" + esc(g.status) + "</span>" +
        "<span>" + g.at.slice(11, 19) + "</span>" + sess + "</div>" +
      "</div>";
    }).join("");
    // Wire the view links (attach activity panel to that session).
    Array.prototype.forEach.call(log.querySelectorAll("a.view"), function (a) {
      a.addEventListener("click", function () { $("session").value = a.getAttribute("data-sid"); connect(); });
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
    fetch("/goal", {
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
    return fetch("/sessions?limit=50")
      .then(function (r) { return r.ok ? r.json() : { sessions: [] }; })
      .then(function (b) { (b.sessions || []).forEach(function (s) { boundSessions[s.sessionId] = true; }); baselineCaptured = true; })
      .catch(function () { baselineCaptured = true; });
  }

  // One poller binds new sessions to queued goals (FIFO) and refreshes each goal's status.
  function pollGoals() {
    if (!baselineCaptured || goals.length === 0) return;
    fetch("/sessions?limit=50")
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
    var u = ["B", "KB", "MB", "GB", "TB"]; var i = 0; var v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + " " + u[i];
  }

  var activeModel = "";

  function loadConfig() {
    fetch("/config")
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
    sel.innerHTML = opts.map(function (n) {
      return "<option value='" + n + "'" + (n === activeModel ? " selected" : "") + ">" + n + "</option>";
    }).join("") || "<option value=''>—</option>";
  }

  function refreshModels() {
    fetch("/models")
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) { $("models").innerHTML = "<li>" + (res.body && res.body.error || "model admin unavailable") + "</li>"; return; }
        var models = (res.body && res.body.models) || [];
        modelNames = models.map(function (m) { return m.name; });
        syncModelSelect();
        $("models").innerHTML = models.length
          ? models.map(function (m) {
              var meta = [m.parameterSize, m.quantization, humanBytes(m.sizeBytes)].filter(Boolean).join(" · ");
              var isActive = m.name === activeModel ? " <span class='chip running'>active</span>" : "";
              return "<li>" + m.name + (meta ? " <span class='cat'>" + meta + "</span>" : "") + isActive + "</li>";
            }).join("")
          : "<li>(no models installed)</li>";
      })
      .catch(function (e) { $("models").innerHTML = "<li>error " + e + "</li>"; });
  }

  function switchModel(name) {
    if (!name || name === activeModel) return;
    fetch("/config/model", {
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
    fetch("/models/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name })
    }).then(function (res) {
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
