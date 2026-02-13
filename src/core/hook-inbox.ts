import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  truncateSync,
} from "fs";
import { watch, FSWatcher } from "fs";
import { join, dirname } from "path";
import { EventEmitter } from "events";

export interface HookEvent {
  type:
    | "session-start"
    | "tool-use"
    | "tool-failure"
    | "subagent-start"
    | "subagent-stop"
    | "stop";
  data: Record<string, unknown>;
}

const HOOK_TYPES = [
  "session-start",
  "tool-use",
  "tool-failure",
  "subagent-start",
  "subagent-stop",
  "stop",
] as const;

/** Fallback poll interval in milliseconds. */
const POLL_INTERVAL_MS = 200;

/**
 * File-based replacement for HookServer.
 *
 * Claude Code hooks append JSON lines to type-specific JSONL files
 * in a global inbox directory. HookInbox watches for changes and
 * emits normalized events via EventEmitter, preserving the same
 * interface that RunManager already uses.
 */
const HOOK_TYPES_SET = new Set<string>(HOOK_TYPES);

export class HookInbox extends EventEmitter {
  private readonly inboxDir: string;
  private offsets = new Map<string, number>();
  /** Leftover bytes from incomplete trailing lines (UTF-8 boundary safety). */
  private leftovers = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(dataDir: string) {
    super();
    this.inboxDir = join(dataDir, "hook-inbox");
  }

  /** Start watching the inbox directory for new hook events. */
  start(): void {
    this.stopped = false;

    // Ensure inbox directory exists
    mkdirSync(this.inboxDir, { recursive: true });

    // Initialise offsets to current file sizes (skip stale data from previous runs)
    for (const hookType of HOOK_TYPES) {
      const filePath = join(this.inboxDir, `${hookType}.jsonl`);
      if (existsSync(filePath)) {
        try {
          this.offsets.set(hookType, statSync(filePath).size);
        } catch {
          this.offsets.set(hookType, 0);
        }
      } else {
        writeFileSync(filePath, "");
        this.offsets.set(hookType, 0);
      }
    }

    // Primary: fs.watch on the directory
    try {
      this.watcher = watch(this.inboxDir, (_eventType, filename) => {
        if (filename && filename.endsWith(".jsonl")) {
          const hookType = filename.replace(/\.jsonl$/, "");
          if (HOOK_TYPES_SET.has(hookType)) {
            this.readNewLines(hookType);
          }
        }
      });
      this.watcher.on("error", () => {
        // Silently ignore watch errors; fallback poll covers us
      });
    } catch {
      // fs.watch not available; rely on polling
    }

    // Fallback: periodic poll for reliability
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  /** Stop watching and clean up inbox files. */
  stop(): void {
    this.stopped = true;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Truncate inbox files to free disk space
    for (const hookType of HOOK_TYPES) {
      const filePath = join(this.inboxDir, `${hookType}.jsonl`);
      if (existsSync(filePath)) {
        try {
          truncateSync(filePath, 0);
        } catch {
          // ignore
        }
      }
    }
    this.offsets.clear();
    this.leftovers.clear();
  }

  /**
   * Generate Claude Code hook configuration file.
   * Writes to the specified path (typically .claude/settings.local.json in the workspace).
   */
  writeHookConfig(outputPath: string): void {
    const appendCmd = (hookType: string) => {
      // Single-quote the path to prevent shell expansion issues with spaces
      const filePath = join(this.inboxDir, `${hookType}.jsonl`);
      return `INPUT=$(cat); printf '%s\\n' "$INPUT" >> '${filePath}'`;
    };

    const config = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: appendCmd("session-start") }],
          },
        ],
        PostToolUse: [
          {
            matcher: "Edit|Write|Bash",
            hooks: [
              { type: "command", command: appendCmd("tool-use"), async: true },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            matcher: "Edit|Write|Bash",
            hooks: [
              {
                type: "command",
                command: appendCmd("tool-failure"),
                async: true,
              },
            ],
          },
        ],
        SubagentStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: appendCmd("subagent-start"),
                async: true,
              },
            ],
          },
        ],
        SubagentStop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: appendCmd("subagent-stop"),
                async: true,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              { type: "command", command: appendCmd("stop"), async: true },
            ],
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

  /** Poll all hook type files for new data. */
  private poll(): void {
    if (this.stopped) return;
    for (const hookType of HOOK_TYPES) {
      this.readNewLines(hookType);
    }
  }

  /** Read new lines from a hook type file since the last tracked offset. */
  private readNewLines(hookType: string): void {
    if (this.stopped) return;
    const filePath = join(this.inboxDir, `${hookType}.jsonl`);
    if (!existsSync(filePath)) return;

    let fileSize: number;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      return;
    }

    const offset = this.offsets.get(hookType) ?? 0;
    if (fileSize <= offset) return;

    const bytesToRead = fileSize - offset;
    const buffer = Buffer.alloc(bytesToRead);

    let fd: number;
    try {
      fd = openSync(filePath, "r");
    } catch {
      // Don't advance offset — retry on next poll
      return;
    }

    let bytesRead: number;
    try {
      bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
    } catch {
      closeSync(fd);
      // Don't advance offset — retry on next poll
      return;
    }
    closeSync(fd);

    // Advance offset by actual bytes read
    this.offsets.set(hookType, offset + bytesRead);

    // Prepend any leftover from the previous read (UTF-8 boundary safety)
    const leftover = this.leftovers.get(hookType) ?? "";
    const newData = leftover + buffer.slice(0, bytesRead).toString("utf-8");

    // Split into lines; keep trailing incomplete line as leftover for next read
    const parts = newData.split("\n");
    const trailingPart = parts.pop() ?? "";
    this.leftovers.set(hookType, trailingPart);

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed lines
      }
      this.emitNormalized(hookType, data);
    }
  }

  /** Normalize raw hook data and emit a typed event (same as HookServer.handleRequest). */
  private emitNormalized(
    hookType: string,
    data: Record<string, unknown>
  ): void {
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
  }
}
