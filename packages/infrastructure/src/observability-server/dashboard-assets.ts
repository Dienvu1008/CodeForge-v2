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
</style>
</head>
<body>
<header>
  <strong>CodeForge</strong>
  <input id="session" placeholder="session id" size="26" />
  <button id="connect">Connect</button>
  <span id="status">disconnected</span>
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
  </section>
  <section>
    <h2>Task Graph</h2>
    <ul id="tasks"></ul>
  </section>
  <section>
    <h2>Live Activity</h2>
    <ul id="activity"></ul>
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
        var tl = st.tasks.map(function (t) {
          var cls = t.isActive ? "active" : (t.isBlocked ? "blocked" : (t.state === "PASSED" ? "passed" : ""));
          var mark = t.isActive ? "●" : (t.state === "PASSED" ? "✓" : (t.isBlocked ? "⊘" : "○"));
          return "<li class='task " + cls + "'>" + mark + " " + t.taskId + " — " + t.state + "</li>";
        }).join("");
        $("tasks").innerHTML = tl || "<li>(no tasks)</li>";
      });
  }

  function renderActivity(entries) {
    $("activity").innerHTML = entries.slice(-200).map(function (e) {
      return "<li>" + e.at.slice(11, 19) + " <span class='cat'>" + e.category + "</span> " + e.eventType + "</li>";
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
        var li = document.createElement("li");
        li.textContent = (e.at || "").slice(11, 19) + "  " + e.type;
        $("activity").appendChild(li);
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

  $("connect").addEventListener("click", connect);
  Array.prototype.forEach.call(document.querySelectorAll(".controls button"), function (b) {
    b.addEventListener("click", function () { sendControl(b.getAttribute("data-intent")); });
  });
})();`;
