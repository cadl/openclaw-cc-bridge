/** Inline HTML page for the debug UI. */
export function getDebugPageHtml(wsPort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>openclaw-cc-bridge debug</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; height: 100vh; display: flex; flex-direction: column; }

  /* -- Header -- */
  .header { padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .header label { font-size: 12px; color: #8b949e; }
  .header input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 6px; font-size: 13px; font-family: inherit; }
  .header input#workspace { width: 320px; }
  .header select { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 6px; font-size: 13px; font-family: inherit; max-width: 360px; cursor: pointer; }
  .header select:focus { outline: none; border-color: #58a6ff; }
  .session-id { font-size: 12px; color: #8b949e; margin-left: auto; }
  .session-id code { color: #58a6ff; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .status-dot.idle { background: #3fb950; }
  .status-dot.running { background: #d29922; animation: pulse 1s infinite; }
  .status-dot.error { background: #f85149; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* -- Input area -- */
  .input-area { padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; gap: 8px; }
  .input-area textarea { flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 10px 12px; border-radius: 8px; font-size: 14px; font-family: inherit; resize: vertical; min-height: 44px; max-height: 200px; }
  .input-area textarea:focus { outline: none; border-color: #58a6ff; }
  .input-area button { padding: 8px 20px; border-radius: 8px; border: none; font-size: 14px; font-family: inherit; cursor: pointer; }
  .btn-send { background: #238636; color: #fff; }
  .btn-send:hover { background: #2ea043; }
  .btn-send:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }
  .btn-plan { background: #1f3a5f; color: #58a6ff; border: 1px solid #58a6ff; }
  .btn-plan:hover { background: #264a7a; }
  .btn-plan.active { background: #58a6ff; color: #0d1117; }
  .btn-plan:disabled { background: #21262d; color: #484f58; cursor: not-allowed; border-color: #484f58; }
  .btn-execute { background: #a371f7; color: #fff; }
  .btn-execute:hover { background: #b889f9; }
  .btn-execute:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }
  .btn-reset { background: #30363d; color: #c9d1d9; }
  .btn-reset:hover { background: #3b424b; }

  /* -- Main panels -- */
  .panels { flex: 1; display: flex; overflow: hidden; }
  .panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .panel + .panel { border-left: 1px solid #30363d; }
  .panel-header { padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 12px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
  .panel-header .count { background: #30363d; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
  .panel-body { flex: 1; overflow-y: auto; padding: 8px; }

  /* -- Events -- */
  .event { padding: 6px 10px; margin-bottom: 4px; border-radius: 6px; font-size: 12px; line-height: 1.5; border-left: 3px solid transparent; background: #161b22; }
  .event .time { color: #6e7681; margin-right: 8px; font-size: 11px; }
  .event .tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-right: 6px; text-transform: uppercase; }
  .event pre { margin-top: 4px; padding: 6px 8px; background: #0d1117; border-radius: 4px; overflow-x: auto; font-size: 11px; white-space: pre-wrap; word-break: break-all; }

  .event.tool-use { border-left-color: #58a6ff; }
  .event.tool-use .tag { background: #1f3a5f; color: #58a6ff; }
  .event.text { border-left-color: #3fb950; }
  .event.text .tag { background: #1a3a2a; color: #3fb950; }
  .event.hook { border-left-color: #d29922; }
  .event.hook .tag { background: #3d2e00; color: #d29922; }
  .event.result { border-left-color: #a371f7; }
  .event.result .tag { background: #2d1f4e; color: #a371f7; }
  .event.error { border-left-color: #f85149; }
  .event.error .tag { background: #3d1416; color: #f85149; }
  .event.session { border-left-color: #8b949e; }
  .event.session .tag { background: #21262d; color: #8b949e; }

  /* -- Result area -- */
  .result-area { border-top: 1px solid #30363d; max-height: 40vh; display: flex; flex-direction: column; overflow: hidden; }
  .result-area .panel-header { position: sticky; top: 0; z-index: 1; flex-shrink: 0; }
  .result-meta { padding: 8px 16px; font-size: 11px; color: #8b949e; border-top: 1px solid #21262d; flex-shrink: 0; }

  /* -- Result split view -- */
  .result-split { display: flex; flex: 1; overflow: hidden; min-height: 0; }
  .result-pane { flex: 1; overflow-y: auto; padding: 12px 16px; min-width: 0; }
  .result-divider { width: 1px; background: #30363d; flex-shrink: 0; }
  .result-pane pre { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: #c9d1d9; margin: 0; font-family: inherit; }
  .result-pane pre:empty::after { content: "Waiting for response..."; color: #484f58; font-style: italic; }

  /* -- Markdown body (GitHub-like dark) -- */
  .markdown-body { font-size: 14px; line-height: 1.6; color: #c9d1d9; }
  .markdown-body:empty::after { content: "Waiting for response..."; color: #484f58; font-style: italic; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3 { color: #e6edf3; border-bottom: 1px solid #21262d; padding-bottom: 6px; margin: 16px 0 8px; }
  .markdown-body h1 { font-size: 1.5em; }
  .markdown-body h2 { font-size: 1.3em; }
  .markdown-body h3 { font-size: 1.1em; }
  .markdown-body p { margin: 8px 0; }
  .markdown-body code { background: #1c2128; padding: 2px 6px; border-radius: 4px; font-size: 12px; font-family: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, monospace; }
  .markdown-body pre { background: #0d1117; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
  .markdown-body pre code { background: none; padding: 0; font-size: 13px; }
  .markdown-body ul, .markdown-body ol { padding-left: 24px; margin: 8px 0; }
  .markdown-body li { margin: 4px 0; }
  .markdown-body hr { border: none; border-top: 1px solid #21262d; margin: 16px 0; }
  .markdown-body em { color: #8b949e; }
  .markdown-body strong { color: #e6edf3; }
  .markdown-body a { color: #58a6ff; text-decoration: none; }
  .markdown-body a:hover { text-decoration: underline; }
  .markdown-body blockquote { border-left: 3px solid #30363d; padding-left: 12px; color: #8b949e; margin: 8px 0; }
  .markdown-body details { margin: 8px 0; }
  .markdown-body summary { cursor: pointer; color: #58a6ff; font-weight: 600; }
  .markdown-body summary:hover { text-decoration: underline; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <span class="status-dot idle" id="statusDot"></span>
  <label>Workspace</label>
  <input type="text" id="workspace" placeholder="/path/to/project" />
  <label>Allowed Tools</label>
  <input type="text" id="allowedTools" value="Read,Edit,Write,Bash,Glob,Grep" style="width:260px" />
  <label>Session</label>
  <select id="sessionSelect" onchange="onSessionSelect()">
    <option value="">New Session</option>
  </select>
  <div class="session-id">Session: <code id="sessionId">none</code></div>
</div>

<!-- Input -->
<div class="input-area">
  <textarea id="prompt" rows="2" placeholder="Enter your prompt... (Ctrl+Enter to send)"></textarea>
  <button class="btn-plan" id="planBtn" onclick="togglePlanMode()" title="Toggle plan mode (read-only analysis)">Plan</button>
  <button class="btn-send" id="sendBtn" onclick="sendPrompt()">Send</button>
  <button class="btn-execute" id="executeBtn" onclick="executePlan()" style="display:none">Execute</button>
  <button class="btn-reset" onclick="resetSession()">Reset</button>
</div>

<!-- Panels -->
<div class="panels">
  <div class="panel">
    <div class="panel-header">Stream Events <span class="count" id="streamCount">0</span></div>
    <div class="panel-body" id="streamEvents"></div>
  </div>
  <div class="panel">
    <div class="panel-header">Hook Events <span class="count" id="hookCount">0</span></div>
    <div class="panel-body" id="hookEvents"></div>
  </div>
</div>

<!-- Result -->
<div class="result-area">
  <div class="panel-header">Result</div>
  <div class="result-split">
    <div class="result-pane" id="resultRaw">
      <pre id="resultRawContent"></pre>
    </div>
    <div class="result-divider"></div>
    <div class="result-pane" id="resultPreview">
      <div class="markdown-body" id="resultPreviewContent"></div>
    </div>
  </div>
  <div class="result-meta" id="resultMeta"></div>
</div>

<script>
const ws = new WebSocket("ws://localhost:${wsPort}");
let streamCount = 0, hookCount = 0;
let planMode = false;
let hasPendingPlan = false;
let lastSentPrompt = "";

function togglePlanMode() {
  planMode = !planMode;
  const btn = document.getElementById("planBtn");
  btn.classList.toggle("active", planMode);
  document.getElementById("sendBtn").textContent = planMode ? "Send (Plan)" : "Send";
}

function showExecuteButton(show) {
  document.getElementById("executeBtn").style.display = show ? "inline-block" : "none";
  hasPendingPlan = show;
}

function updateResultDisplay(markdown) {
  document.getElementById("resultRawContent").textContent = markdown;
  if (typeof marked !== "undefined") {
    document.getElementById("resultPreviewContent").innerHTML = marked.parse(markdown || "");
  } else {
    document.getElementById("resultPreviewContent").textContent = markdown;
  }
}

function clearResultDisplay() {
  document.getElementById("resultRawContent").textContent = "";
  document.getElementById("resultPreviewContent").innerHTML = "";
  document.getElementById("resultMeta").textContent = "";
}

function executePlan() {
  const notes = document.getElementById("prompt").value.trim();
  const workspace = document.getElementById("workspace").value.trim();
  if (!workspace) { alert("Please set a workspace directory"); return; }

  clearResultDisplay();
  showExecuteButton(false);

  ws.send(JSON.stringify({
    action: "execute",
    prompt: notes || undefined,
    workspace,
  }));
  document.getElementById("prompt").value = "";
}

// Load session history into dropdown
async function loadSessions() {
  try {
    const res = await fetch("/api/store/sessions");
    const list = await res.json();
    const sel = document.getElementById("sessionSelect");
    // Keep the first "New Session" option, remove the rest
    while (sel.options.length > 1) sel.remove(1);
    for (const s of list) {
      const opt = document.createElement("option");
      opt.value = s.sessionId;
      const time = new Date(s.lastUpdatedAt).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
      });
      const preview = s.firstPrompt ? s.firstPrompt.slice(0, 40) + (s.firstPrompt.length > 40 ? "..." : "") : s.sessionId.slice(0, 8) + "...";
      opt.textContent = preview + " | " + time + (s.workspace ? " | " + s.workspace.split("/").pop() : "");
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error("Failed to load sessions:", e);
  }
}

function onSessionSelect() {
  const sel = document.getElementById("sessionSelect");
  const sid = sel.value;
  if (sid) {
    ws.send(JSON.stringify({ action: "set-session", sessionId: sid }));
    document.getElementById("sessionId").textContent = sid;
  } else {
    ws.send(JSON.stringify({ action: "reset" }));
    document.getElementById("sessionId").textContent = "none";
    document.getElementById("streamEvents").innerHTML = "";
    document.getElementById("hookEvents").innerHTML = "";
    clearResultDisplay();
    streamCount = 0;
    hookCount = 0;
    document.getElementById("streamCount").textContent = "0";
    document.getElementById("hookCount").textContent = "0";
  }
}

ws.onopen = () => {
  addEvent("streamEvents", "session", "Connected to debug server");
  loadSessions();
};
ws.onclose = () => addEvent("streamEvents", "error", "WebSocket disconnected");
ws.onerror = () => addEvent("streamEvents", "error", "WebSocket error");

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  const ts = msg.data?.timestamp || Date.now();
  switch (msg.type) {
    case "tool-use":
      streamCount++;
      addEvent("streamEvents", "tool-use",
        \`<span class="tag">tool</span>\${msg.data.name}\`,
        msg.data.input ? JSON.stringify(msg.data.input, null, 2) : null, ts);
      break;
    case "text":
      streamCount++;
      addEvent("streamEvents", "text",
        \`<span class="tag">text</span>\${escHtml(msg.data.text).slice(0, 200)}\`, null, ts);
      break;
    case "session-id": {
      document.getElementById("sessionId").textContent = msg.data.sessionId;
      // Sync dropdown: add if new, then select it
      const sel = document.getElementById("sessionSelect");
      const existingOpt = [...sel.options].find(o => o.value === msg.data.sessionId);
      if (!existingOpt) {
        const opt = document.createElement("option");
        opt.value = msg.data.sessionId;
        const time = new Date(ts).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
        });
        const preview = lastSentPrompt
          ? lastSentPrompt.slice(0, 40) + (lastSentPrompt.length > 40 ? "..." : "")
          : msg.data.sessionId.slice(0, 8) + "...";
        opt.textContent = preview + " | " + time;
        sel.insertBefore(opt, sel.options[1]);
      }
      sel.value = msg.data.sessionId;
      addEvent("streamEvents", "session",
        \`<span class="tag">session</span>\${msg.data.sessionId}\`, null, ts);
      break;
    }
    case "plan-result":
    case "result": {
      const isPlan = msg.type === "plan-result";
      const composedMarkdown = msg.data.composedMarkdown || msg.data.result || "";
      updateResultDisplay(composedMarkdown);
      const meta = [];
      if (isPlan) meta.push("PLAN");
      if (msg.data.num_turns) meta.push(msg.data.num_turns + " turns");
      if (msg.data.duration_ms) meta.push((msg.data.duration_ms/1000).toFixed(1) + "s");
      if (msg.data.cost_usd) meta.push("$" + msg.data.cost_usd.toFixed(4));
      if (msg.data.toolUses?.length) meta.push(msg.data.toolUses.length + " tools");
      document.getElementById("resultMeta").textContent = meta.join(" | ");
      if (isPlan) showExecuteButton(true);
      streamCount++;
      const tagLabel = isPlan ? "plan" : "result";
      addEvent("streamEvents", "result",
        \`<span class="tag">\${tagLabel}</span>\${(msg.data.result || "").slice(0, 100)}...\`, null, ts);
      // Refresh session list to get proper names from server
      loadSessions().then(() => {
        // Re-select current session after reload
        if (msg.data.session_id) {
          document.getElementById("sessionSelect").value = msg.data.session_id;
        }
      });
      break;
    }
    case "error":
      addEvent("streamEvents", "error",
        \`<span class="tag">error</span>\${escHtml(msg.data.message)}\`);
      break;
    case "session-history": {
      // Clear panels and load historical events
      document.getElementById("streamEvents").innerHTML = "";
      document.getElementById("hookEvents").innerHTML = "";
      clearResultDisplay();
      streamCount = 0;
      hookCount = 0;

      const hist = msg.data;
      document.getElementById("sessionId").textContent = hist.sessionId;

      // Fill workspace from session meta
      if (hist.meta?.workspace) {
        document.getElementById("workspace").value = hist.meta.workspace;
      }

      // Show meta in result area
      if (hist.meta) {
        const m = [];
        if (hist.meta.totalTurns) m.push(hist.meta.totalTurns + " turns");
        if (hist.meta.totalDurationMs) m.push((hist.meta.totalDurationMs / 1000).toFixed(1) + "s");
        if (hist.meta.totalCostUsd) m.push("$" + hist.meta.totalCostUsd.toFixed(4));
        if (hist.meta.model) m.push(hist.meta.model);
        document.getElementById("resultMeta").textContent = m.join(" | ");
      }

      // Replay stream events
      for (const ev of hist.streamEvents || []) {
        streamCount++;
        const evTs = ev.ts || Date.now();
        const evData = ev.data || {};
        const evType = ev.type || evData.type;
        if (evType === "assistant") {
          const content = evData.message?.content || [];
          for (const block of content) {
            if (block.type === "tool_use") {
              addEvent("streamEvents", "tool-use",
                \`<span class="tag">tool</span>\${block.name}\`,
                block.input ? JSON.stringify(block.input, null, 2) : null, evTs);
            } else if (block.type === "text") {
              addEvent("streamEvents", "text",
                \`<span class="tag">text</span>\${escHtml(block.text || "").slice(0, 200)}\`, null, evTs);
            }
          }
        } else if (evType === "result") {
          addEvent("streamEvents", "result",
            \`<span class="tag">result</span>\${escHtml((evData.result || "").slice(0, 100))}...\`, null, evTs);
        } else if (evType === "system") {
          addEvent("streamEvents", "session",
            \`<span class="tag">system</span>\${evData.session_id || ""}\`, null, evTs);
        }
      }

      // Replay hook events
      for (const ev of hist.hookEvents || []) {
        hookCount++;
        const evTs = ev.ts || Date.now();
        const evData = ev.data || {};
        const hookType = ev.type || "unknown";
        if (hookType === "session-start") {
          addEvent("hookEvents", "hook",
            \`<span class="tag">session-start</span>model: \${evData.model || "?"}\`,
            JSON.stringify(evData, null, 2), evTs);
        } else if (hookType === "tool-use") {
          addEvent("hookEvents", "hook",
            \`<span class="tag">tool-use</span>\${evData.tool_name || evData.toolName || "?"}: \${JSON.stringify(evData.tool_input || evData.toolInput || {}).slice(0, 100)}\`, null, evTs);
        } else if (hookType === "tool-failure") {
          addEvent("hookEvents", "error",
            \`<span class="tag">tool-fail</span>\${evData.tool_name || evData.toolName || "?"}: \${JSON.stringify(evData.tool_response || evData.error || {}).slice(0, 100)}\`, null, evTs);
        } else if (hookType === "subagent-start") {
          addEvent("hookEvents", "hook",
            \`<span class="tag">subagent+</span>\${evData.agent_type || evData.agentType || "?"}\`, null, evTs);
        } else if (hookType === "subagent-stop") {
          addEvent("hookEvents", "hook",
            \`<span class="tag">subagent-</span>\${evData.agent_type || evData.agentType || "?"}\`, null, evTs);
        } else if (hookType === "stop") {
          addEvent("hookEvents", "hook",
            \`<span class="tag">stop</span>session: \${evData.session_id || evData.sessionId || "?"}\`, null, evTs);
        }
      }

      // Display composed markdown from server
      if (hist.composedMarkdown) {
        updateResultDisplay(hist.composedMarkdown);
      }

      document.getElementById("streamCount").textContent = streamCount;
      document.getElementById("hookCount").textContent = hookCount;
      break;
    }
    case "status": {
      const dot = document.getElementById("statusDot");
      dot.className = "status-dot " + msg.data.state;
      const isRunning = msg.data.state === "running";
      document.getElementById("sendBtn").disabled = isRunning;
      document.getElementById("planBtn").disabled = isRunning;
      document.getElementById("executeBtn").disabled = isRunning;
      break;
    }
    // Hook events
    case "hook:session-start":
      hookCount++;
      addEvent("hookEvents", "hook",
        \`<span class="tag">session-start</span>model: \${msg.data.model || "?"}\`,
        JSON.stringify(msg.data, null, 2), ts);
      break;
    case "hook:tool-use":
      hookCount++;
      addEvent("hookEvents", "hook",
        \`<span class="tag">tool-use</span>\${msg.data.toolName}: \${JSON.stringify(msg.data.toolInput || {}).slice(0, 100)}\`, null, ts);
      break;
    case "hook:tool-failure":
      hookCount++;
      addEvent("hookEvents", "error",
        \`<span class="tag">tool-fail</span>\${msg.data.toolName}: \${JSON.stringify(msg.data.error || {}).slice(0, 100)}\`, null, ts);
      break;
    case "hook:subagent-start":
      hookCount++;
      addEvent("hookEvents", "hook",
        \`<span class="tag">subagent+</span>\${msg.data.agentType || "?"}\`, null, ts);
      break;
    case "hook:subagent-stop":
      hookCount++;
      addEvent("hookEvents", "hook",
        \`<span class="tag">subagent-</span>\${msg.data.agentType || "?"}\`, null, ts);
      break;
    case "hook:stop":
      hookCount++;
      addEvent("hookEvents", "hook",
        \`<span class="tag">stop</span>session: \${msg.data.sessionId || "?"}\`,
        msg.data.transcriptPath ? "transcript: " + msg.data.transcriptPath : null, ts);
      break;
  }
  document.getElementById("streamCount").textContent = streamCount;
  document.getElementById("hookCount").textContent = hookCount;
};

function addEvent(panelId, cls, html, pre, timestamp) {
  const panel = document.getElementById(panelId);
  const div = document.createElement("div");
  div.className = "event " + cls;
  const ts = timestamp || Date.now();
  div.dataset.ts = String(ts);
  const d = new Date(ts);
  const dateStr = d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
  const timeStr = dateStr + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  div.innerHTML = \`<span class="time">\${timeStr}</span>\${html}\`;
  if (pre) div.innerHTML += \`<pre>\${escHtml(pre)}</pre>\`;

  // Insert in sorted position by timestamp
  let inserted = false;
  const children = panel.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const childTs = Number(children[i].dataset.ts || 0);
    if (childTs <= ts) {
      if (i === children.length - 1) {
        panel.appendChild(div);
      } else {
        panel.insertBefore(div, children[i + 1]);
      }
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    panel.insertBefore(div, panel.firstChild);
  }

  panel.scrollTop = panel.scrollHeight;
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function sendPrompt() {
  const prompt = document.getElementById("prompt").value.trim();
  if (!prompt) return;
  const workspace = document.getElementById("workspace").value.trim();
  const allowedTools = document.getElementById("allowedTools").value.trim();
  if (!workspace) { alert("Please set a workspace directory"); return; }

  clearResultDisplay();
  showExecuteButton(false);
  lastSentPrompt = prompt;

  ws.send(JSON.stringify({
    action: planMode ? "plan" : "send",
    prompt,
    workspace,
    allowedTools: allowedTools ? allowedTools.split(",").map(s => s.trim()) : undefined,
  }));
  document.getElementById("prompt").value = "";
}

function resetSession() {
  document.getElementById("sessionId").textContent = "none";
  document.getElementById("sessionSelect").value = "";
  showExecuteButton(false);
  ws.send(JSON.stringify({ action: "reset" }));
  addEvent("streamEvents", "session", '<span class="tag">reset</span>Session cleared');
}

// Ctrl+Enter to send
document.getElementById("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendPrompt(); }
});
</script>
</body>
</html>`;
}
