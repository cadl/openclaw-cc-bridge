import * as http from "http";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { EventEmitter } from "events";

export interface HookEvent {
  type: "session-start" | "tool-use" | "tool-failure" | "subagent-start" | "subagent-stop" | "stop";
  data: Record<string, unknown>;
}

/**
 * Local HTTP server that receives Claude Code hook callbacks.
 *
 * Claude Code hooks are configured to POST to this server when:
 * - SessionStart: Session ID syncing
 * - PostToolUse: Real-time tool activity notifications
 * - Stop: Completion notifications
 */
export class HookServer extends EventEmitter {
  private server: http.Server | null = null;
  private _port = 0;

  get port(): number {
    return this._port;
  }

  /** Start the hook server on a fixed port. */
  async start(port?: number): Promise<number> {
    const targetPort = port ?? parseInt(process.env.OPENCLAW_CC_HOOK_PORT || "19960", 10);
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(targetPort, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) {
          this._port = addr.port;
          resolve(this._port);
        } else {
          reject(new Error("Failed to get server port"));
        }
      });

      this.server.on("error", reject);
    });
  }

  /** Stop the hook server. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Generate Claude Code hook configuration file.
   * Writes to the specified path (typically .claude/settings.local.json in the workspace).
   */
  generateHookConfig(outputPath: string): void {
    const curlCmd = (endpoint: string) =>
      `curl -s -X POST http://127.0.0.1:${this._port}/hook/${endpoint} -H "Content-Type: application/json" -d "$(cat)"`;

    const config = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: curlCmd("session-start") }],
          },
        ],
        PostToolUse: [
          {
            matcher: "Edit|Write|Bash",
            hooks: [{ type: "command", command: curlCmd("tool-use"), async: true }],
          },
        ],
        PostToolUseFailure: [
          {
            matcher: "Edit|Write|Bash",
            hooks: [{ type: "command", command: curlCmd("tool-failure"), async: true }],
          },
        ],
        SubagentStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: curlCmd("subagent-start"), async: true }],
          },
        ],
        SubagentStop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: curlCmd("subagent-stop"), async: true }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: curlCmd("stop"), async: true }],
          },
        ],
      },
    };

    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Merge with existing config to preserve non-hook settings
    let existing: Record<string, unknown> = {};
    if (existsSync(outputPath)) {
      try {
        existing = JSON.parse(readFileSync(outputPath, "utf-8"));
      } catch {
        // Corrupted file, overwrite entirely
      }
    }

    const merged = { ...existing, hooks: config.hooks };
    writeFileSync(outputPath, JSON.stringify(merged, null, 2));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only accept POST to /hook/*
    if (req.method !== "POST" || !req.url?.startsWith("/hook/")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const hookType = req.url!.replace("/hook/", "");

        switch (hookType) {
          case "session-start":
            this.emit("session-start", {
              sessionId: data.session_id,
              source: data.source,
              model: data.model,
              timestamp: Date.now(),
              raw: data,
            });
            break;

          case "tool-use":
            this.emit("tool-use", {
              sessionId: data.session_id,
              toolName: data.tool_name,
              toolInput: data.tool_input,
              toolResponse: data.tool_response,
              timestamp: Date.now(),
              raw: data,
            });
            break;

          case "tool-failure":
            this.emit("tool-failure", {
              sessionId: data.session_id,
              toolName: data.tool_name,
              toolInput: data.tool_input,
              error: data.tool_response || data.error,
              timestamp: Date.now(),
              raw: data,
            });
            break;

          case "subagent-start":
            this.emit("subagent-start", {
              agentType: data.agent_type,
              sessionId: data.session_id,
              timestamp: Date.now(),
              raw: data,
            });
            break;

          case "subagent-stop":
            this.emit("subagent-stop", {
              agentType: data.agent_type,
              sessionId: data.session_id,
              timestamp: Date.now(),
              raw: data,
            });
            break;

          case "stop":
            this.emit("stop", {
              sessionId: data.session_id,
              transcriptPath: data.transcript_path,
              stopHookActive: data.stop_hook_active,
              timestamp: Date.now(),
              raw: data,
            });
            break;

          default:
            break;
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("invalid json");
      }
    });
  }
}
