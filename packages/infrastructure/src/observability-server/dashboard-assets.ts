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
    <ul id="tasks"></ul>
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
        var tl = st.tasks.map(function (t) {
          var unverified = sessionDone && t.state === "VERIFYING";
          var label = unverified ? "VERIFYING (done, unverified — no checks)" : t.state;
          var cls = unverified ? "passed" : (t.isActive ? "active" : (t.isBlocked ? "blocked" : (t.state === "PASSED" ? "passed" : "")));
          var mark = unverified ? "◍" : (t.isActive ? "●" : (t.state === "PASSED" ? "✓" : (t.isBlocked ? "⊘" : "○")));
          return "<li class='task " + cls + "'>" + mark + " " + t.taskId + " — " + label + "</li>";
        }).join("");
        $("tasks").innerHTML = tl || "<li>(no tasks)</li>";
      });
    refreshApproval();
    refreshResult();
  }

  // Find a tool call that is APPROVAL_PENDING and not yet resolved, from the event log, and
  // render Approve/Deny. The agent parks the session at AWAITING_HUMAN until a decision is made;
  // without this the run looks "stuck" in RUNNING/VERIFYING.
  function refreshApproval() {
    if (!sessionId) { $("approval").textContent = "none"; return; }
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
        if (!pending) { $("approval").textContent = "none"; return; }
        $("approval").innerHTML =
          "<div>tool call <b>" + pending + "</b> awaiting your decision</div>" +
          "<div class='controls' style='margin-top:6px'>" +
          "<button id='approveBtn'>Approve</button><button id='denyBtn'>Deny</button></div>";
        $("approveBtn").addEventListener("click", function () { decideTool("approve", pending); });
        $("denyBtn").addEventListener("click", function () { decideTool("deny", pending); });
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
