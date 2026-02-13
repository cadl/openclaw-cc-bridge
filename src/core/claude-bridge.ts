import { spawn } from "child_process";
import { resolve } from "path";
import { createInterface } from "readline";

export interface PendingQuestion {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export interface ClaudeResponse {
  result: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  /** Tool uses collected during processing */
  toolUses: ToolUseEvent[];
  /** Full plan content extracted from ExitPlanMode tool_use (plan mode only) */
  planContent?: string;
  /** Pending AskUserQuestion (Claude stopped because it wanted user input) */
  pendingQuestion?: PendingQuestion;
  /** Number of timeout retries that occurred (0 = no timeouts) */
  retryCount?: number;
}

export interface ToolUseEvent {
  name: string;
  input: Record<string, unknown>;
  timestamp: number;
}

/** Callback for real-time events during Claude processing. */
export interface StreamCallbacks {
  onToolUse?: (event: ToolUseEvent) => void;
  onText?: (text: string, timestamp: number) => void;
  onSessionId?: (sessionId: string, timestamp: number) => void;
  /** Called for every raw NDJSON event (system, assistant, result, etc.) */
  onRawEvent?: (event: Record<string, unknown>) => void;
}

export interface ClaudeBridgeOptions {
  /** Timeout in ms (default: 10 minutes) */
  timeout?: number;
  /** Tools Claude is allowed to use */
  allowedTools?: string[];
  /** Additional CLI flags */
  extraArgs?: string[];
  /** Maximum number of automatic retries on timeout (default: 0 = no retry) */
  maxTimeoutRetries?: number;
  /** Prompt to send when resuming after a timeout (default: "Continue.") */
  timeoutResumePrompt?: string;
  /** Called when a timeout retry starts */
  onTimeoutRetry?: (attempt: number, maxRetries: number, sessionId: string) => void;
}

export class ClaudeTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly sessionId: string | undefined,
    public readonly partialToolUses: ToolUseEvent[],
  ) {
    super(`Claude Code timed out after ${timeoutMs}ms`);
    this.name = "ClaudeTimeoutError";
  }
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

export class ClaudeBridge {
  private timeout: number;
  private allowedTools: string[];
  private extraArgs: string[];
  private maxTimeoutRetries: number;
  private timeoutResumePrompt: string;
  private onTimeoutRetry?: (attempt: number, maxRetries: number, sessionId: string) => void;

  constructor(options: ClaudeBridgeOptions = {}) {
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.allowedTools = options.allowedTools ?? DEFAULT_TOOLS;
    this.extraArgs = options.extraArgs ?? [];
    this.maxTimeoutRetries = options.maxTimeoutRetries ?? 0;
    this.timeoutResumePrompt = options.timeoutResumePrompt ?? "Continue.";
    this.onTimeoutRetry = options.onTimeoutRetry;
  }

  /**
   * Send a prompt to Claude Code using stream-json mode.
   * Parses events in real-time and invokes callbacks for tool use, text, etc.
   * On timeout, automatically retries with --resume if maxTimeoutRetries > 0.
   *
   * @param prompt - The user's message
   * @param cwd - Working directory for this invocation
   * @param sessionId - Optional session ID to resume a previous conversation
   * @param callbacks - Optional callbacks for real-time events
   * @param permissionMode - Optional permission mode (e.g., "plan" to restrict to read-only)
   */
  async send(
    prompt: string,
    cwd: string,
    sessionId?: string,
    callbacks?: StreamCallbacks,
    permissionMode?: string
  ): Promise<ClaudeResponse> {
    let currentPrompt = prompt;
    let currentSessionId = sessionId;
    let retryCount = 0;

    for (let attempt = 0; attempt <= this.maxTimeoutRetries; attempt++) {
      const args = this.buildArgs(currentPrompt, currentSessionId, permissionMode);

      try {
        const response = await this.spawnAndParse("claude", args, resolve(cwd), callbacks);
        return { ...response, retryCount };
      } catch (err) {
        if (
          err instanceof ClaudeTimeoutError &&
          attempt < this.maxTimeoutRetries
        ) {
          const resumeId = err.sessionId || currentSessionId;
          if (!resumeId) throw err; // Cannot resume without a session ID

          this.onTimeoutRetry?.(attempt + 1, this.maxTimeoutRetries, resumeId);
          currentSessionId = resumeId;
          currentPrompt = this.timeoutResumePrompt;
          retryCount++;
          continue;
        }

        throw err;
      }
    }

    // TypeScript: unreachable, but satisfy the compiler
    throw new Error("Unexpected: retry loop exited without result");
  }

  private buildArgs(
    prompt: string,
    sessionId?: string,
    permissionMode?: string
  ): string[] {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    if (permissionMode) {
      args.push("--permission-mode", permissionMode);
    }

    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", this.allowedTools.join(","));
    }

    args.push(...this.extraArgs);
    return args;
  }

  private spawnAndParse(
    cmd: string,
    args: string[],
    cwd: string,
    callbacks?: StreamCallbacks
  ): Promise<ClaudeResponse> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          CLAUDE_CODE_ENTRYPOINT: "openclaw-cc-bridge",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const toolUses: ToolUseEvent[] = [];
      let resultEvent: Record<string, unknown> | null = null;
      let sessionId = "";
      let stderr = "";
      let planContent: string | undefined;
      let pendingQuestion: PendingQuestion | undefined;

      // Parse NDJSON from stdout line-by-line
      const rl = createInterface({ input: child.stdout });

      // Set timeout
      const timer = setTimeout(() => {
        rl.close();
        child.kill("SIGTERM");
        reject(new ClaudeTimeoutError(this.timeout, sessionId || undefined, toolUses));
      }, this.timeout);

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const event = JSON.parse(trimmed);
          callbacks?.onRawEvent?.(event);
          this.handleEvent(event, toolUses, callbacks, (sid) => {
            sessionId = sid;
          }, (plan) => {
            planContent = plan;
          }, (question) => {
            pendingQuestion = question;
          });

          if (event.type === "result") {
            resultEvent = event;
          }
        } catch {
          // Skip unparseable lines
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        rl.close();

        if (!resultEvent) {
          const stderrMsg = stderr ? `\nstderr: ${stderr.slice(0, 500)}` : "";
          reject(
            new Error(
              `Claude Code exited with code ${code}, no result event received${stderrMsg}`
            )
          );
          return;
        }

        resolve({
          result: (resultEvent.result as string) ?? "",
          session_id:
            (resultEvent.session_id as string) || sessionId,
          cost_usd: resultEvent.total_cost_usd as number | undefined,
          duration_ms: resultEvent.duration_ms as number | undefined,
          num_turns: resultEvent.num_turns as number | undefined,
          toolUses,
          planContent,
          pendingQuestion,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        rl.close();
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      // Close stdin immediately (no interactive input)
      child.stdin.end();
    });
  }

  private handleEvent(
    event: Record<string, unknown>,
    toolUses: ToolUseEvent[],
    callbacks: StreamCallbacks | undefined,
    onSessionId: (sid: string) => void,
    onPlanContent?: (plan: string) => void,
    onPendingQuestion?: (question: PendingQuestion) => void
  ): void {
    const type = event.type as string;

    const now = Date.now();

    switch (type) {
      case "system": {
        const sid = event.session_id as string;
        if (sid) {
          onSessionId(sid);
          callbacks?.onSessionId?.(sid, now);
        }
        break;
      }

      case "assistant": {
        const message = event.message as Record<string, unknown> | undefined;
        const content = (message?.content as Array<Record<string, unknown>>) ?? [];
        for (const block of content) {
          if (block.type === "tool_use") {
            const toolEvent: ToolUseEvent = {
              name: block.name as string,
              input: (block.input as Record<string, unknown>) ?? {},
              timestamp: now,
            };
            toolUses.push(toolEvent);
            callbacks?.onToolUse?.(toolEvent);

            // Capture full plan content from ExitPlanMode tool_use
            if (block.name === "ExitPlanMode") {
              const input = block.input as Record<string, unknown> | undefined;
              const plan = input?.plan as string | undefined;
              if (plan && onPlanContent) {
                onPlanContent(plan);
              }
            }

            // Capture AskUserQuestion (Claude wants to ask the user something)
            if (block.name === "AskUserQuestion") {
              const input = block.input as Record<string, unknown> | undefined;
              const questions = input?.questions as PendingQuestion["questions"] | undefined;
              if (questions && onPendingQuestion) {
                onPendingQuestion({ questions });
              }
            }
          } else if (block.type === "text") {
            callbacks?.onText?.(block.text as string, now);
          }
        }
        break;
      }
    }
  }
}
