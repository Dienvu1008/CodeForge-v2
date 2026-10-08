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
  <section>
    <h2>Submit Goal</h2>
    <div class="controls">
      <input id="goalInput" placeholder="describe a goal for the runtime" size="40" />
      <button id="submitGoal">Submit</button>
    </div>
    <div id="goalResult"></div>
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

  function submitGoal() {
    var desc = $("goalInput").value.trim();
    if (!desc) return;
    fetch("/goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: desc })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        $("goalResult").textContent = res.ok
          ? ("queued goal " + res.body.goalId + " at position " + res.body.position)
          : ("error: " + (res.body && res.body.error));
        if (res.ok) $("goalInput").value = "";
      })
      .catch(function (e) { $("goalResult").textContent = "error " + e; });
  }

  function humanBytes(n) {
    if (!n && n !== 0) return "";
    var u = ["B", "KB", "MB", "GB", "TB"]; var i = 0; var v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + " " + u[i];
  }

  function refreshModels() {
    fetch("/models")
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) { $("models").innerHTML = "<li>" + (res.body && res.body.error || "model admin unavailable") + "</li>"; return; }
        var models = (res.body && res.body.models) || [];
        $("models").innerHTML = models.length
          ? models.map(function (m) {
              var meta = [m.parameterSize, m.quantization, humanBytes(m.sizeBytes)].filter(Boolean).join(" · ");
              return "<li>" + m.name + (meta ? " <span class='cat'>" + meta + "</span>" : "") + "</li>";
            }).join("")
          : "<li>(no models installed)</li>";
      })
      .catch(function (e) { $("models").innerHTML = "<li>error " + e + "</li>"; });
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
  $("submitGoal").addEventListener("click", submitGoal);
  $("pullBtn").addEventListener("click", pullModel);
  $("refreshModels").addEventListener("click", refreshModels);
  refreshModels();
})();`;
