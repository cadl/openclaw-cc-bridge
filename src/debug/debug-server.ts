import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { ClaudeBridge } from "../core/claude-bridge";
import { HookInbox } from "../core/hook-inbox";
import { SessionManager } from "../core/session-manager";
import { EventStore } from "../core/event-store";
import { RunManager } from "../core/run-manager";
import { getDebugPageHtml } from "./debug-page";
import { join } from "path";
import { reconstructComposedMarkdown } from "../core/compose-result";

const DEBUG_PORT = parseInt(process.env.DEBUG_PORT || "3456", 10);
const DATA_DIR =
  process.env.OPENCLAW_CC_DATA_DIR ||
  join(process.env.HOME || "~", ".openclaw", "openclaw-cc-bridge");

async function main() {
  const sessions = new SessionManager(DATA_DIR);
  const hookInbox = new HookInbox(DATA_DIR);
  const bridge = new ClaudeBridge({
    maxTimeoutRetries: 2,
    onTimeoutRetry: (attempt, maxRetries, sessionId) => {
      console.log(
        `[debug] Timeout recovery: retry ${attempt}/${maxRetries} (session: ${sessionId})`
      );
    },
  });
  const eventStore = new EventStore(DATA_DIR);
  const runManager = new RunManager(bridge, hookInbox, eventStore);

  // Start hook inbox watcher
  hookInbox.start();
  console.log(`Hook inbox: ${DATA_DIR}/hook-inbox/`);

  // Write hook config into the project's .claude directory so it only
  // affects Claude Code sessions running inside this workspace.
  const hookConfigPath = join(process.cwd(), ".claude", "settings.local.json");
  hookInbox.writeHookConfig(hookConfigPath);
  console.log(`Hook config written to ${hookConfigPath}`);

  // HTTP server (serves debug page + REST API)
  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res, sessions, eventStore);
  });

  // WebSocket server (attached to HTTP server)
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set<WebSocket>();
  const clientStates = new Map<WebSocket, ClientState>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    clientStates.set(ws, { sessionId: undefined, pendingPlan: false });
    broadcast(clients, { type: "status", data: { state: "idle" } });

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", data: { message: "Invalid JSON" } }));
        return;
      }
      const state = clientStates.get(ws)!;
      handleWsMessage(msg as any, ws, state, clients, bridge, runManager, hookInbox, sessions, eventStore)
        .catch((err) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", data: { message: String(err) } }));
          }
        });
    });

    ws.on("close", () => {
      clients.delete(ws);
      clientStates.delete(ws);
    });
  });

  // Start HTTP server
  httpServer.listen(DEBUG_PORT, () => {
    console.log(`Debug UI:    http://localhost:${DEBUG_PORT}`);
    console.log("\nReady. Open the URL above in your browser.");
  });

  // Clean up on shutdown
  process.on("SIGINT", () => {
    hookInbox.stop();
    eventStore.flush();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    hookInbox.stop();
    eventStore.flush();
    process.exit(0);
  });

  // --- HTTP handler ---
  function handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessions: SessionManager,
    store: EventStore
  ) {
    const url = req.url || "";

    // Serve debug page
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDebugPageHtml(DEBUG_PORT));
      return;
    }

    // GET /api/sessions — OpenClaw sender sessions
    if (req.method === "GET" && url === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions.list()));
      return;
    }

    // GET /api/store/sessions — persisted session index
    if (req.method === "GET" && url === "/api/store/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(store.listSessions()));
      return;
    }

    // GET /api/store/sessions/:id
    const metaMatch = url.match(/^\/api\/store\/sessions\/([^/]+)$/);
    if (req.method === "GET" && metaMatch) {
      const meta = store.getSessionMeta(metaMatch[1]);
      if (!meta) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(meta));
      return;
    }

    // GET /api/store/sessions/:id/stream
    const streamMatch = url.match(/^\/api\/store\/sessions\/([^/]+)\/stream$/);
    if (req.method === "GET" && streamMatch) {
      const events = store.readStreamEvents(streamMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(events));
      return;
    }

    // GET /api/store/sessions/:id/hooks
    const hooksMatch = url.match(/^\/api\/store\/sessions\/([^/]+)\/hooks$/);
    if (req.method === "GET" && hooksMatch) {
      const events = store.readHookEvents(hooksMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(events));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  }
}

/** Per-WebSocket-client state. */
interface ClientState {
  sessionId: string | undefined;
  pendingPlan: boolean;
}

/** Handle WebSocket messages from the browser. */
async function handleWsMessage(
  msg: { action: string; prompt?: string; workspace?: string; allowedTools?: string[]; sessionId?: string },
  ws: WebSocket,
  state: ClientState,
  clients: Set<WebSocket>,
  bridge: ClaudeBridge,
  runManager: RunManager,
  hookInbox: HookInbox,
  sessions: SessionManager,
  eventStore: EventStore,
) {
  if (msg.action === "reset") {
    state.sessionId = undefined;
    state.pendingPlan = false;
    return;
  }

  if (msg.action === "set-session") {
    state.sessionId = msg.sessionId || undefined;
    state.pendingPlan = false;
    if (state.sessionId) {
      const meta = eventStore.getSessionMeta(state.sessionId);
      const streamEvents = eventStore.readStreamEvents(state.sessionId);
      const hookEvents = eventStore.readHookEvents(state.sessionId);

      // Reconstruct composedMarkdown from stored events
      const composedMarkdown = reconstructComposedMarkdown(
        streamEvents,
        hookEvents,
        meta
      );

      ws.send(JSON.stringify({
        type: "session-history",
        data: { sessionId: state.sessionId, meta, streamEvents, hookEvents, composedMarkdown },
      }));
    }
    return;
  }

  if (msg.action === "execute") {
    if (!state.pendingPlan || !state.sessionId) {
      ws.send(JSON.stringify({ type: "error", data: { message: "No pending plan to execute" } }));
      return;
    }

    const workspace = msg.workspace;
    if (!workspace) {
      ws.send(JSON.stringify({ type: "error", data: { message: "workspace is required" } }));
      return;
    }

    const additionalNotes = msg.prompt?.trim();
    const executePrompt = additionalNotes
      ? `Proceed with the plan. Additional notes: ${additionalNotes}`
      : "Proceed with the plan.";

    broadcast(clients, { type: "status", data: { state: "running" } });
    state.pendingPlan = false;

    try {
      const run = await runManager.execute({
        prompt: executePrompt,
        workspace,
        sessionId: state.sessionId,
        handle: {
          onHookEvent: (type, data) => broadcast(clients, { type: `hook:${type}`, data }),
          onStreamEvent: (type, data) => broadcast(clients, { type, data }),
        },
      });

      state.sessionId = run.response.session_id;

      broadcast(clients, {
        type: "result",
        data: {
          result: run.response.result,
          composedMarkdown: run.composedMarkdown,
          session_id: run.response.session_id,
          cost_usd: run.response.cost_usd,
          duration_ms: run.response.duration_ms,
          num_turns: run.response.num_turns,
          toolUses: run.response.toolUses,
          pendingQuestion: run.response.pendingQuestion,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      // Restore pending plan on failure so user can retry
      state.pendingPlan = true;
      const message = err instanceof Error ? err.message : String(err);
      broadcast(clients, { type: "error", data: { message } });
    } finally {
      broadcast(clients, { type: "status", data: { state: "idle" } });
    }
    return;
  }

  if (msg.action === "send" || msg.action === "plan") {
    const isPlan = msg.action === "plan";
    const { prompt, workspace, allowedTools } = msg;
    if (!prompt || !workspace) {
      ws.send(JSON.stringify({ type: "error", data: { message: "prompt and workspace are required" } }));
      return;
    }

    // Sending a new message clears any pending plan
    if (msg.action === "send") {
      state.pendingPlan = false;
    }

    broadcast(clients, { type: "status", data: { state: "running" } });

    try {
      // Create a per-request RunManager if custom allowedTools
      let activeRunManager = runManager;
      if (allowedTools && allowedTools.length > 0) {
        const customBridge = new ClaudeBridge({ allowedTools });
        activeRunManager = new RunManager(customBridge, hookInbox, eventStore);
      }

      const run = await activeRunManager.execute({
        prompt,
        workspace,
        sessionId: state.sessionId,
        isNewSession: !state.sessionId,
        promptLabel: isPlan ? "[plan]" : undefined,
        permissionMode: isPlan ? "plan" : undefined,
        handle: {
          onHookEvent: (type, data) => broadcast(clients, { type: `hook:${type}`, data }),
          onStreamEvent: (type, data) => broadcast(clients, { type, data }),
        },
      });

      state.sessionId = run.response.session_id;

      if (isPlan) {
        state.pendingPlan = true;
      }

      broadcast(clients, {
        type: isPlan ? "plan-result" : "result",
        data: {
          result: run.response.result,
          composedMarkdown: run.composedMarkdown,
          session_id: run.response.session_id,
          cost_usd: run.response.cost_usd,
          duration_ms: run.response.duration_ms,
          num_turns: run.response.num_turns,
          toolUses: run.response.toolUses,
          pendingQuestion: run.response.pendingQuestion,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast(clients, { type: "error", data: { message } });
    } finally {
      broadcast(clients, { type: "status", data: { state: "idle" } });
    }
  }
}

function broadcast(clients: Set<WebSocket>, data: unknown) {
  const json = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
