import { ClaudeBridge, ClaudeResponse } from "./claude-bridge";
import { HookInbox } from "./hook-inbox";
import { EventStore } from "./event-store";
import {
  composeResultMarkdown,
  formatHookToolActivity,
  formatHookSubagentActivity,
  ToolActivity,
  SubagentActivity,
} from "./compose-result";

/** Callbacks for callers that need real-time event notifications (e.g. debug server WebSocket broadcast). */
export interface RunHandle {
  onHookEvent?: (type: string, data: unknown) => void;
  onStreamEvent?: (type: string, data: unknown) => void;
}

export interface RunResult {
  response: ClaudeResponse;
  composedMarkdown: string;
  hookActivities: ToolActivity[];
  subagentActivities: SubagentActivity[];
  accumulatedText: string;
}

export interface RunOptions {
  prompt: string;
  workspace: string;
  sessionId?: string;
  permissionMode?: string;
  /** Whether this is a new session (affects firstPrompt metadata). */
  isNewSession?: boolean;
  /** Label prefix for firstPrompt metadata (e.g. "[plan]"). */
  promptLabel?: string;
  handle?: RunHandle;
}

/** Delay in ms to wait for trailing async hook events after bridge.send() returns. */
const HOOK_DRAIN_DELAY_MS = 100;

/**
 * Manages a single Claude Code execution run:
 * - Registers per-run hook event listeners (routed by session_id)
 * - Constructs StreamCallbacks for bridge.send()
 * - Accumulates text, hook activities, subagent activities
 * - Persists events to EventStore
 * - Composes the final markdown result
 *
 * Concurrent executions on the same workspace are serialized via a
 * per-workspace mutex to prevent hook event cross-contamination and
 * workspace file conflicts.
 */
export class RunManager {
  /** Per-workspace execution mutex: maps workspace path → tail of the promise chain. */
  private workspaceLocks = new Map<string, Promise<unknown>>();

  constructor(
    private bridge: ClaudeBridge,
    private hookInbox: HookInbox,
    private eventStore: EventStore,
  ) {}

  async execute(opts: RunOptions): Promise<RunResult> {
    // Serialize concurrent executions on the same workspace to prevent
    // hook event cross-contamination between runs.
    const prev = this.workspaceLocks.get(opts.workspace) ?? Promise.resolve();
    let resolveLock: () => void;
    const lock = new Promise<void>((r) => { resolveLock = r; });
    this.workspaceLocks.set(opts.workspace, lock);

    try {
      await prev;
      return await this.executeInner(opts);
    } finally {
      resolveLock!();
      // Clean up map entry if no other execution is queued behind us
      if (this.workspaceLocks.get(opts.workspace) === lock) {
        this.workspaceLocks.delete(opts.workspace);
      }
    }
  }

  private async executeInner(opts: RunOptions): Promise<RunResult> {
    const hookActivities: ToolActivity[] = [];
    const subagentActivities: SubagentActivity[] = [];
    let accumulatedText = "";
    let streamSessionId: string | undefined;
    // Track the session_id from session-start hook to correlate subsequent events
    let hookSessionId: string | undefined;

    // --- Register temporary hook listeners scoped to this run ---

    const onSessionStart = (data: Record<string, unknown>) => {
      const sid = data.sessionId as string | undefined;
      if (sid) {
        // Only accept the first session-start (the parent session).
        // Subsequent ones (from subagents) carry different session IDs
        // and would create orphaned EventStore entries.
        if (!hookSessionId) {
          hookSessionId = sid;
          this.eventStore.ensureSession(sid, {
            model: data.model as string | undefined,
            source: data.source as string | undefined,
          });
          this.eventStore.appendHookEvent(sid, "session-start", (data.raw as Record<string, unknown>) ?? data);
        }
      }
      opts.handle?.onHookEvent?.("session-start", data);
    };

    const onToolUse = (data: Record<string, unknown>) => {
      const sid = (data.sessionId as string | undefined) || hookSessionId;
      if (sid && sid === (streamSessionId || hookSessionId)) {
        hookActivities.push(formatHookToolActivity((data.raw as Record<string, unknown>) ?? data));
        this.eventStore.appendHookEvent(sid, "tool-use", (data.raw as Record<string, unknown>) ?? data);
      }
      opts.handle?.onHookEvent?.("tool-use", data);
    };

    const onToolFailure = (data: Record<string, unknown>) => {
      const sid = (data.sessionId as string | undefined) || hookSessionId;
      if (sid && sid === (streamSessionId || hookSessionId)) {
        hookActivities.push(formatHookToolActivity((data.raw as Record<string, unknown>) ?? data, true));
        this.eventStore.appendHookEvent(sid, "tool-failure", (data.raw as Record<string, unknown>) ?? data);
      }
      opts.handle?.onHookEvent?.("tool-failure", data);
    };

    const onSubagentStart = (data: Record<string, unknown>) => {
      const sid = (data.sessionId as string | undefined) || hookSessionId;
      if (sid && sid === (streamSessionId || hookSessionId)) {
        subagentActivities.push(formatHookSubagentActivity((data.raw as Record<string, unknown>) ?? data, "start"));
        this.eventStore.appendHookEvent(sid, "subagent-start", (data.raw as Record<string, unknown>) ?? data);
      }
      opts.handle?.onHookEvent?.("subagent-start", data);
    };

    const onSubagentStop = (data: Record<string, unknown>) => {
      const sid = (data.sessionId as string | undefined) || hookSessionId;
      if (sid && sid === (streamSessionId || hookSessionId)) {
        subagentActivities.push(formatHookSubagentActivity((data.raw as Record<string, unknown>) ?? data, "stop"));
        this.eventStore.appendHookEvent(sid, "subagent-stop", (data.raw as Record<string, unknown>) ?? data);
      }
      opts.handle?.onHookEvent?.("subagent-stop", data);
    };

    const onStop = (data: Record<string, unknown>) => {
      const sid = (data.sessionId as string | undefined) || hookSessionId;
      if (sid) {
        this.eventStore.appendHookEvent(sid, "stop", (data.raw as Record<string, unknown>) ?? data);
      }
      opts.handle?.onHookEvent?.("stop", data);
    };

    // Register all listeners
    this.hookInbox.on("session-start", onSessionStart);
    this.hookInbox.on("tool-use", onToolUse);
    this.hookInbox.on("tool-failure", onToolFailure);
    this.hookInbox.on("subagent-start", onSubagentStart);
    this.hookInbox.on("subagent-stop", onSubagentStop);
    this.hookInbox.on("stop", onStop);

    try {
      const response = await this.bridge.send(
        opts.prompt,
        opts.workspace,
        opts.sessionId,
        {
          onToolUse: (event) => {
            opts.handle?.onStreamEvent?.("tool-use", event);
          },
          onText: (text, timestamp) => {
            accumulatedText += text;
            opts.handle?.onStreamEvent?.("text", { text, timestamp });
          },
          onSessionId: (sid, timestamp) => {
            if (!streamSessionId) {
              streamSessionId = sid;
            }
            // Only create/update session metadata for the parent session
            if (sid === streamSessionId) {
              const isNew = opts.isNewSession ?? !opts.sessionId;
              const label = opts.promptLabel ? `${opts.promptLabel} ${opts.prompt}` : opts.prompt;
              this.eventStore.ensureSession(sid, {
                workspace: opts.workspace,
                ...(isNew && { firstPrompt: label }),
              });
            }
            opts.handle?.onStreamEvent?.("session-id", { sessionId: sid, timestamp });
          },
          onRawEvent: (event) => {
            if (event.type === "system" && event.session_id) {
              const sid = event.session_id as string;
              // Only accept the first session (parent). Sub-agents carry different IDs.
              if (!streamSessionId) {
                streamSessionId = sid;
              }
            }
            if (streamSessionId) {
              this.eventStore.appendStreamEvent(streamSessionId, event);
            }
          },
        },
        opts.permissionMode,
      );

      // Wait briefly for trailing async hook events
      await new Promise(resolve => setTimeout(resolve, HOOK_DRAIN_DELAY_MS));

      // Update session meta
      if (response.session_id) {
        this.eventStore.updateSessionMeta(response.session_id, {
          totalCostUsd: response.cost_usd,
          totalDurationMs: response.duration_ms,
          totalTurns: response.num_turns,
        });
      }

      const composedMarkdown = composeResultMarkdown({
        thinkingText: accumulatedText,
        hookToolActivities: hookActivities,
        subagentActivities,
        result: response.result,
        planContent: response.planContent,
        pendingQuestion: response.pendingQuestion,
        meta: {
          numTurns: response.num_turns,
          durationMs: response.duration_ms,
          costUsd: response.cost_usd,
        },
      });

      return {
        response,
        composedMarkdown,
        hookActivities,
        subagentActivities,
        accumulatedText,
      };
    } finally {
      // Always clean up listeners
      this.hookInbox.removeListener("session-start", onSessionStart);
      this.hookInbox.removeListener("tool-use", onToolUse);
      this.hookInbox.removeListener("tool-failure", onToolFailure);
      this.hookInbox.removeListener("subagent-start", onSubagentStart);
      this.hookInbox.removeListener("subagent-stop", onSubagentStop);
      this.hookInbox.removeListener("stop", onStop);
    }
  }
}
