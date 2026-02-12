import { existsSync } from "fs";
import { join, resolve } from "path";
import { ClaudeBridge } from "../core/claude-bridge";
import { SessionManager } from "../core/session-manager";
import { HookServer } from "../core/hook-server";
import { EventStore } from "../core/event-store";
import { RunManager } from "../core/run-manager";

/**
 * OpenClaw plugin API types.
 * These are inferred from OpenClaw docs - adjust if the actual API differs.
 */
interface PluginApi {
  registerCommand(opts: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: CommandContext) => Promise<{ text: string }>;
  }): void;

  registerService(opts: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;

  logger: {
    info(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };

  config: Record<string, unknown>;
}

interface CommandContext {
  senderId: string;
  channel: string;
  args: string;
  authorized: boolean;
}

const DEFAULT_WORKSPACE = process.env.OPENCLAW_CC_WORKSPACE || process.cwd();
const DATA_DIR =
  process.env.OPENCLAW_CC_DATA_DIR ||
  join(process.env.HOME || "~", ".openclaw", "openclaw-cc-bridge");

/**
 * Parse -w / --workspace flag from command args.
 * Returns the resolved workspace path and the remaining args with the flag removed.
 */
function parseWorkspaceArg(
  args: string,
  activeWorkspace: string
): { workspace: string; rest: string } {
  const match = args.match(/(?:^|\s)(?:-w|--workspace)\s+(\S+)/);
  if (match) {
    const workspace = resolve(match[1]);
    const rest = args.replace(match[0], "").trim();
    return { workspace, rest };
  }
  return { workspace: activeWorkspace, rest: args };
}

/**
 * OpenClaw plugin registration entry point.
 */
export default function register(api: PluginApi) {
  const defaultWorkspace =
    (api.config.workspace as string) || DEFAULT_WORKSPACE;
  const allowedTools =
    (api.config.allowedTools as string[] | undefined) ?? undefined;

  const bridge = new ClaudeBridge({
    allowedTools,
    maxTimeoutRetries: 2,
    onTimeoutRetry: (attempt, maxRetries, sessionId) => {
      api.logger.info(
        `[openclaw-cc-bridge] Timeout recovery: retry ${attempt}/${maxRetries} (session: ${sessionId})`
      );
    },
  });
  const sessions = new SessionManager(DATA_DIR);
  const hookServer = new HookServer();
  const eventStore = new EventStore(DATA_DIR);
  const runManager = new RunManager(bridge, hookServer, eventStore);

  /** Track which workspaces already have hook configs written. */
  const configuredWorkspaces = new Set<string>();

  /** Resolve the active working directory for a sender. */
  function getActiveWorkspace(senderId: string): string {
    return sessions.getActiveWorkspace(senderId) || defaultWorkspace;
  }

  /** Ensure hook config exists in the workspace's .claude directory. */
  function ensureHookConfig(workspace: string): void {
    if (configuredWorkspaces.has(workspace)) return;
    const hookConfigPath = join(workspace, ".claude", "settings.local.json");
    hookServer.generateHookConfig(hookConfigPath);
    configuredWorkspaces.add(workspace);
    api.logger.debug(`[openclaw-cc-bridge] Hook config ensured at ${hookConfigPath}`);
  }

  // --- Background service: Hook Server ---
  api.registerService({
    id: "claude-hook-server",
    start: async () => {
      const port = await hookServer.start();
      api.logger.info(`[openclaw-cc-bridge] Hook server started on port ${port}`);
    },
    stop: async () => {
      eventStore.flush();
      await hookServer.stop();
      api.logger.info("[openclaw-cc-bridge] Hook server stopped");
    },
  });

  // --- /cc [-w <path>] <message> ---
  api.registerCommand({
    name: "cc",
    description: "Send a message to Claude Code for processing",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const { workspace, rest: prompt } = parseWorkspaceArg(
        ctx.args.trim(),
        getActiveWorkspace(ctx.senderId)
      );

      if (!prompt) {
        return {
          text: [
            "Usage: /cc [-w <workspace>] <your message>",
            "Example: /cc fix the bug in auth.py",
            "Example: /cc -w /path/to/project fix the bug",
            "",
            "Other commands:",
            "  /cc-plan <message>    — create a plan first (read-only)",
            "  /cc-execute           — execute a pending plan",
            "  /cc-workspace <path>  — set/list working directory",
            "  /cc-reset             — reset session(s)",
            "  /cc-status            — show all session info",
          ].join("\n"),
        };
      }

      if (!existsSync(workspace)) {
        return { text: `Workspace does not exist: ${workspace}` };
      }

      const wsSession = sessions.getSession(ctx.senderId, workspace);
      const existingSession = wsSession?.claudeSessionId;

      // Using /cc while a plan is pending clears the plan state
      if (sessions.hasPendingPlan(ctx.senderId, workspace)) {
        sessions.setPendingPlan(ctx.senderId, workspace, false);
      }

      // If there's a pending question, wrap the user's reply as a response
      let effectivePrompt = prompt;
      const pq = sessions.getPendingQuestion(ctx.senderId, workspace);
      if (pq) {
        effectivePrompt = `The user responded to your previous question with: "${prompt}"\nPlease continue based on their choice.`;
        sessions.setPendingQuestion(ctx.senderId, workspace, undefined);
      }

      try {
        api.logger.info(
          `[openclaw-cc-bridge] [${workspace}] "${prompt.slice(0, 50)}..." from ${ctx.senderId}`
        );

        ensureHookConfig(workspace);

        const run = await runManager.execute({
          prompt: effectivePrompt,
          workspace,
          sessionId: existingSession,
          isNewSession: !existingSession,
        });

        sessions.updateSession(ctx.senderId, workspace, run.response.session_id);
        sessions.setActiveWorkspace(ctx.senderId, workspace);

        // Track pending question state
        if (run.response.pendingQuestion) {
          sessions.setPendingQuestion(ctx.senderId, workspace, run.response.pendingQuestion);
        }

        return { text: run.composedMarkdown };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] Error: ${msg}`);
        return { text: `Error from Claude Code: ${msg}` };
      }
    },
  });

  // --- /cc-plan [-w <path>] <message> ---
  api.registerCommand({
    name: "cc-plan",
    description:
      "Ask Claude Code to analyze and create a plan (read-only, no modifications)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const { workspace, rest: prompt } = parseWorkspaceArg(
        ctx.args.trim(),
        getActiveWorkspace(ctx.senderId)
      );

      if (!prompt) {
        return {
          text: [
            "Usage: /cc-plan [-w <workspace>] <your task description>",
            "Example: /cc-plan refactor the authentication module",
            "",
            "Claude will analyze the codebase and produce an implementation plan",
            "without making any changes. Review the plan, then:",
            "  /cc-execute           — execute the plan as-is",
            "  /cc-execute <notes>   — execute with additional instructions",
            "  /cc-reset             — discard the plan",
          ].join("\n"),
        };
      }

      if (!existsSync(workspace)) {
        return { text: `Workspace does not exist: ${workspace}` };
      }

      // If there is already a pending plan for this workspace, warn the user
      if (sessions.hasPendingPlan(ctx.senderId, workspace)) {
        return {
          text: [
            `There is already a pending plan for workspace: ${workspace}`,
            "Use /cc-execute to proceed, /cc-reset to discard, or /cc-plan again to replace it.",
          ].join("\n"),
        };
      }

      const wsSession = sessions.getSession(ctx.senderId, workspace);
      const existingSession = wsSession?.claudeSessionId;

      try {
        api.logger.info(
          `[openclaw-cc-bridge] [plan] [${workspace}] "${prompt.slice(0, 50)}..." from ${ctx.senderId}`
        );

        ensureHookConfig(workspace);

        const run = await runManager.execute({
          prompt,
          workspace,
          sessionId: existingSession,
          isNewSession: !existingSession,
          promptLabel: "[plan]",
          permissionMode: "plan",
        });

        sessions.updateSession(ctx.senderId, workspace, run.response.session_id);
        sessions.setActiveWorkspace(ctx.senderId, workspace);
        sessions.setPendingPlan(ctx.senderId, workspace, true);

        let text = run.composedMarkdown;
        text += "\n\n---";
        text += "\nTo proceed: `/cc-execute` or `/cc-execute <additional notes>`";
        text += "\nTo discard: `/cc-reset`";

        return { text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] [plan] Error: ${msg}`);
        return { text: `Error from Claude Code (plan): ${msg}` };
      }
    },
  });

  // --- /cc-execute [-w <path>] [notes] ---
  api.registerCommand({
    name: "cc-execute",
    description: "Execute a previously created plan",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const { workspace, rest: additionalNotes } = parseWorkspaceArg(
        ctx.args.trim(),
        getActiveWorkspace(ctx.senderId)
      );

      if (!sessions.hasPendingPlan(ctx.senderId, workspace)) {
        return {
          text: `No pending plan for workspace: ${workspace}\nUse /cc-plan <message> to create one first.`,
        };
      }

      const wsSession = sessions.getSession(ctx.senderId, workspace);
      const existingSession = wsSession?.claudeSessionId;

      if (!existingSession) {
        return {
          text: "Session lost. Use /cc-plan to create a new plan.",
        };
      }

      const executePrompt = additionalNotes
        ? `Proceed with the plan. Additional notes: ${additionalNotes}`
        : "Proceed with the plan.";

      try {
        api.logger.info(
          `[openclaw-cc-bridge] [execute] [${workspace}] resuming session ${existingSession} from ${ctx.senderId}`
        );

        // Clear pending plan before execution
        sessions.setPendingPlan(ctx.senderId, workspace, false);

        ensureHookConfig(workspace);

        const run = await runManager.execute({
          prompt: executePrompt,
          workspace,
          sessionId: existingSession,
        });

        sessions.updateSession(ctx.senderId, workspace, run.response.session_id);

        return { text: run.composedMarkdown };
      } catch (err) {
        // Restore pending plan state on failure so user can retry
        sessions.setPendingPlan(ctx.senderId, workspace, true);
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] [execute] Error: ${msg}`);
        return { text: `Error executing plan: ${msg}` };
      }
    },
  });

  // --- /cc-workspace [path] ---
  api.registerCommand({
    name: "cc-workspace",
    description: "Set or list working directories for Claude Code",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const rawPath = ctx.args.trim();

      // No argument: show active workspace and all workspace sessions
      if (!rawPath) {
        const activeWs = getActiveWorkspace(ctx.senderId);
        const allSessions = sessions.listSessions(ctx.senderId);

        const lines = [`Active workspace: ${activeWs}`];

        if (allSessions.length > 0) {
          lines.push("", "All workspace sessions:");
          for (const ws of allSessions) {
            const marker = ws.workspace === activeWs ? " *" : "";
            const planTag = ws.pendingPlan ? " [pending plan]" : "";
            const questionTag = ws.pendingQuestion ? " [awaiting reply]" : "";
            lines.push(
              `  ${ws.workspace}${marker}${planTag}${questionTag} (${ws.messageCount} messages)`
            );
          }
        }

        lines.push("", "Usage: /cc-workspace /path/to/project");
        return { text: lines.join("\n") };
      }

      const absPath = resolve(rawPath);

      if (!existsSync(absPath)) {
        return { text: `Directory does not exist: ${absPath}` };
      }

      const previousActive = getActiveWorkspace(ctx.senderId);
      sessions.setActiveWorkspace(ctx.senderId, absPath);

      // Ensure hook config exists in the new workspace
      ensureHookConfig(absPath);

      const changed = previousActive !== absPath;
      const existingSession = sessions.getSession(ctx.senderId, absPath);
      const sessionInfo = existingSession
        ? `Existing session found (${existingSession.messageCount} messages).`
        : "No existing session. Next /cc message starts a new conversation.";

      return {
        text: changed
          ? `Active workspace set to: ${absPath}\n${sessionInfo}`
          : `Active workspace already set to: ${absPath}`,
      };
    },
  });

  // --- /cc-reset [-w <path> | --all] ---
  api.registerCommand({
    name: "cc-reset",
    description: "Reset Claude Code session(s)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const args = ctx.args.trim();

      // --all: reset all workspace sessions
      if (args === "--all") {
        const count = sessions.removeAllSessions(ctx.senderId);
        return {
          text:
            count > 0
              ? `Reset ${count} workspace session(s). Next /cc message starts fresh.`
              : "No active sessions to reset.",
        };
      }

      // -w <path>: reset specific workspace
      const wsMatch = args.match(/^(?:-w|--workspace)\s+(\S+)$/);
      if (wsMatch) {
        const workspace = resolve(wsMatch[1]);
        const removed = sessions.removeSession(ctx.senderId, workspace);
        return {
          text: removed
            ? `Session reset for workspace: ${workspace}`
            : `No active session for workspace: ${workspace}`,
        };
      }

      // No args: reset active workspace session
      if (!args) {
        const activeWs = getActiveWorkspace(ctx.senderId);
        const removed = sessions.removeSession(ctx.senderId, activeWs);
        return {
          text: removed
            ? `Session reset for workspace: ${activeWs}\nNext /cc message starts a new conversation.`
            : "No active session to reset.",
        };
      }

      return {
        text: [
          "Usage:",
          "  /cc-reset              — reset active workspace session",
          "  /cc-reset -w <path>    — reset specific workspace session",
          "  /cc-reset --all        — reset all workspace sessions",
        ].join("\n"),
      };
    },
  });

  // --- /cc-status [-w <path>] ---
  api.registerCommand({
    name: "cc-status",
    description: "Show Claude Code session status",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const activeWs = getActiveWorkspace(ctx.senderId);
      const { workspace: filterWs, rest } = parseWorkspaceArg(
        ctx.args.trim(),
        ""
      );
      // If -w was specified, show only that workspace
      const specificWorkspace = filterWs || undefined;

      if (specificWorkspace) {
        const ws = sessions.getSession(ctx.senderId, specificWorkspace);
        if (!ws) {
          return { text: `No active session for workspace: ${specificWorkspace}` };
        }
        const active = ws.workspace === activeWs ? " (active)" : "";
        const lines = [
          `### ${ws.workspace}${active}`,
          `Session: ${ws.claudeSessionId || "(new)"}`,
          `Messages: ${ws.messageCount}`,
          `Last active: ${new Date(ws.lastActive).toISOString()}`,
        ];
        if (ws.pendingPlan) {
          lines.push("Plan: pending (use /cc-execute to proceed)");
        }
        if (ws.pendingQuestion) {
          lines.push("Question: Claude is waiting for your reply (use /cc to answer)");
        }
        return { text: lines.join("\n") };
      }

      const allSessions = sessions.listSessions(ctx.senderId);

      if (allSessions.length === 0) {
        return {
          text: `No active sessions.\nDefault workspace: ${defaultWorkspace}`,
        };
      }

      const lines = [`Active workspace: ${activeWs}`, ""];

      for (const ws of allSessions) {
        const active = ws.workspace === activeWs ? " (active)" : "";
        lines.push(`### ${ws.workspace}${active}`);
        lines.push(`Session: ${ws.claudeSessionId || "(new)"}`);
        lines.push(`Messages: ${ws.messageCount}`);
        lines.push(`Last active: ${new Date(ws.lastActive).toISOString()}`);
        if (ws.pendingPlan) {
          lines.push("Plan: pending (use /cc-execute to proceed)");
        }
        if (ws.pendingQuestion) {
          lines.push("Question: Claude is waiting for your reply (use /cc to answer)");
        }
        lines.push("");
      }

      return { text: lines.join("\n") };
    },
  });

  api.logger.info(
    `[openclaw-cc-bridge] Plugin registered (default workspace: ${defaultWorkspace})`
  );
}
