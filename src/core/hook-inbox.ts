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

/** Maps Claude Code hook_event_name to our internal event type. */
const HOOK_EVENT_MAP: Record<string, HookEvent["type"]> = {
  SessionStart: "session-start",
  PostToolUse: "tool-use",
  PostToolUseFailure: "tool-failure",
  SubagentStart: "subagent-start",
  SubagentStop: "subagent-stop",
  Stop: "stop",
};

/** Fallback poll interval in milliseconds. */
const POLL_INTERVAL_MS = 200;

const EVENTS_FILE = "events.jsonl";

/**
 * File-based hook event capture.
 *
 * All Claude Code hooks append JSON lines to a single events.jsonl file
 * in a global inbox directory. HookInbox watches for changes and emits
 * normalized events via EventEmitter, using the `hook_event_name` field
 * in each payload to determine the event type.
 */
export class HookInbox extends EventEmitter {
  private readonly inboxDir: string;
  private readonly eventsPath: string;
  private offset = 0;
  /** Leftover bytes from incomplete trailing lines (UTF-8 boundary safety). */
  private leftover = "";
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(dataDir: string) {
    super();
    this.inboxDir = join(dataDir, "hook-inbox");
    this.eventsPath = join(this.inboxDir, EVENTS_FILE);
  }

  /** Start watching the inbox file for new hook events. */
  start(): void {
    this.stopped = false;

    // Ensure inbox directory exists
    mkdirSync(this.inboxDir, { recursive: true });

    // Initialise offset to current file size (skip stale data from previous runs)
    if (existsSync(this.eventsPath)) {
      try {
        this.offset = statSync(this.eventsPath).size;
      } catch {
        this.offset = 0;
      }
    } else {
      writeFileSync(this.eventsPath, "");
      this.offset = 0;
    }

    // Primary: fs.watch on the single file (more reliable than directory watch)
    try {
      this.watcher = watch(this.eventsPath, () => {
        this.readNewLines();
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

  /** Stop watching and clean up inbox file. */
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

    // Truncate inbox file to free disk space
    if (existsSync(this.eventsPath)) {
      try {
        truncateSync(this.eventsPath, 0);
      } catch {
        // ignore
      }
    }
    this.offset = 0;
    this.leftover = "";
  }

  /**
   * Generate Claude Code hook configuration file.
   * Writes to the specified path (typically .claude/settings.local.json in the workspace).
   */
  writeHookConfig(outputPath: string): void {
    // Single-quote the path to prevent shell expansion issues with spaces
    const appendCmd = `INPUT=$(cat); printf '%s\\n' "$INPUT" >> '${this.eventsPath}'`;

    const hookEntry = (matcher?: string, async_?: boolean) => {
      const entry: Record<string, unknown> = {
        hooks: [{ type: "command", command: appendCmd, ...(async_ && { async: true }) }],
      };
      if (matcher !== undefined) {
        entry.matcher = matcher;
      }
      return entry;
    };

    const config = {
      hooks: {
        SessionStart: [hookEntry("")],
        PostToolUse: [hookEntry("Edit|Write|Bash", true)],
        PostToolUseFailure: [hookEntry("Edit|Write|Bash", true)],
        SubagentStart: [hookEntry("", true)],
        SubagentStop: [hookEntry("", true)],
        Stop: [hookEntry(undefined, true)],
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

  /** Poll the events file for new data. */
  private poll(): void {
    if (this.stopped) return;
    this.readNewLines();
  }

  /** Read new lines from the events file since the last tracked offset. */
  private readNewLines(): void {
    if (this.stopped) return;
    if (!existsSync(this.eventsPath)) return;

    let fileSize: number;
    try {
      fileSize = statSync(this.eventsPath).size;
    } catch {
      return;
    }

    if (fileSize <= this.offset) return;

    const bytesToRead = fileSize - this.offset;
    const buffer = Buffer.alloc(bytesToRead);

    let fd: number;
    try {
      fd = openSync(this.eventsPath, "r");
    } catch {
      // Don't advance offset — retry on next poll
      return;
    }

    let bytesRead: number;
    try {
      bytesRead = readSync(fd, buffer, 0, bytesToRead, this.offset);
    } catch {
      closeSync(fd);
      // Don't advance offset — retry on next poll
      return;
    }
    closeSync(fd);

    // Advance offset by actual bytes read
    this.offset += bytesRead;

    // Prepend any leftover from the previous read (UTF-8 boundary safety)
    const newData = this.leftover + buffer.slice(0, bytesRead).toString("utf-8");

    // Split into lines; keep trailing incomplete line as leftover for next read
    const parts = newData.split("\n");
    this.leftover = parts.pop() ?? "";

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed lines
      }
      this.emitNormalized(data);
    }
  }

  /** Normalize raw hook data and emit a typed event based on hook_event_name. */
  private emitNormalized(data: Record<string, unknown>): void {
    const hookEventName = data.hook_event_name as string | undefined;
    if (!hookEventName) return;

    const eventType = HOOK_EVENT_MAP[hookEventName];
    if (!eventType) return;

    switch (eventType) {
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
