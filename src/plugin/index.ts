import { existsSync } from "fs";
import { join, resolve } from "path";
import { ClaudeBridge } from "../core/claude-bridge";
import { SessionManager } from "../core/session-manager";
import { HookInbox } from "../core/hook-inbox";
import { EventStore } from "../core/event-store";
import { RunManager } from "../core/run-manager";

/**
 * OpenClaw plugin API types.
 * These are inferred from OpenClaw docs - adjust if the actual API differs.
 */
interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

interface PluginApi {
  registerCommand(opts: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: CommandContext) => Promise<{ text: string }>;
  }): void;

  registerTool(
    opts: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
    },
    options?: { optional?: boolean },
  ): void;

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

  pluginConfig: Record<string, unknown>;
}

interface CommandContext {
  senderId: string;
  channel: string;
  args: string;
  authorized: boolean;
}

const DATA_DIR =
  process.env.OPENCLAW_CC_DATA_DIR ||
  join(process.env.HOME || "~", ".openclaw", "openclaw-cc-bridge");

const AGENT_SENDER_ID = "agent";

/**
 * Parse -w / --workspace flag from command args.
 * Returns the resolved workspace path and the remaining args with the flag removed.
 */
function parseWorkspaceArg(
  args: string,
  activeWorkspace: string | undefined
): { workspace: string | undefined; rest: string } {
  const match = args.match(/(?:^|\s)(?:-w|--workspace)\s+(\S+)/);
  if (match) {
    const workspace = resolve(match[1]);
    const rest = args.replace(match[0], "").trim();
    return { workspace, rest };
  }
  return { workspace: activeWorkspace, rest: args };
}

const VALID_MODELS = ["sonnet", "opus", "haiku", "sonnet[1m]", "opusplan"];

/**
 * Parse -m / --model flag from command args.
 * Returns the model name and the remaining args with the flag removed.
 */
function parseModelArg(args: string): { model: string | undefined; rest: string } {
  const match = args.match(/(?:^|\s)(?:-m|--model)\s+(\S+)/);
  if (match) {
    const model = match[1];
    const rest = args.replace(match[0], "").trim();
    if (!VALID_MODELS.includes(model)) {
      return { model: undefined, rest: args };
    }
    return { model, rest };
  }
  return { model: undefined, rest: args };
}

/** Helper: wrap text in a ToolResult. */
function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * OpenClaw plugin registration entry point.
 */
export default function register(api: PluginApi) {
  const pluginConfig = api.pluginConfig ?? {};

  const allowedTools =
    (pluginConfig.allowedTools as string[] | undefined) ?? undefined;
  const env =
    (pluginConfig.env as Record<string, string> | undefined) ?? undefined;
  const defaultModel =
    (pluginConfig.model as string | undefined) ?? undefined;

  api.logger.info(`[openclaw-cc-bridge] env: ${env ? Object.keys(env).join(", ") : "(none)"}`);
  if (env?.ANTHROPIC_BASE_URL) {
    api.logger.info(`[openclaw-cc-bridge] ANTHROPIC_BASE_URL: ${env.ANTHROPIC_BASE_URL}`);
  }
  if (defaultModel) {
    api.logger.info(`[openclaw-cc-bridge] default model: ${defaultModel}`);
  }

  const bridge = new ClaudeBridge({
    allowedTools,
    env,
    model: defaultModel,
    maxTimeoutRetries: 2,
    onTimeoutRetry: (attempt, maxRetries, sessionId) => {
      api.logger.info(
        `[openclaw-cc-bridge] Timeout recovery: retry ${attempt}/${maxRetries} (session: ${sessionId})`
      );
    },
  });
  const sessions = new SessionManager(DATA_DIR);
  const hookInbox = new HookInbox(DATA_DIR);
  const eventStore = new EventStore(DATA_DIR);
  const runManager = new RunManager(bridge, hookInbox, eventStore);

  /** Track which workspaces already have hook configs written. */
  const configuredWorkspaces = new Set<string>();

  /** Ensure hook config exists in the workspace's .claude directory. */
  function ensureHookConfig(workspace: string): void {
    if (configuredWorkspaces.has(workspace)) return;
    const hookConfigPath = join(workspace, ".claude", "settings.local.json");
    hookInbox.writeHookConfig(hookConfigPath);
    configuredWorkspaces.add(workspace);
    api.logger.debug(`[openclaw-cc-bridge] Hook config ensured at ${hookConfigPath}`);
  }

  // =====================================================================
  // Shared logic: used by both command handlers and agent tools
  // =====================================================================

  async function doSend(senderId: string, workspace: string, prompt: string, model?: string): Promise<string> {
    if (!existsSync(workspace)) {
      return `Workspace does not exist: ${workspace}`;
    }

    const wsSession = sessions.getSession(senderId, workspace);
    const existingSession = wsSession?.claudeSessionId;

    if (sessions.hasPendingPlan(senderId, workspace)) {
      sessions.setPendingPlan(senderId, workspace, false);
    }

    let effectivePrompt = prompt;
    const pq = sessions.getPendingQuestion(senderId, workspace);
    if (pq) {
      effectivePrompt = `The user responded to your previous question with: "${prompt}"\nPlease continue based on their choice.`;
      sessions.setPendingQuestion(senderId, workspace, undefined);
    }

    api.logger.info(
      `[openclaw-cc-bridge] [${workspace}] "${prompt.slice(0, 50)}..." from ${senderId}`
    );

    ensureHookConfig(workspace);

    const run = await runManager.execute({
      prompt: effectivePrompt,
      workspace,
      sessionId: existingSession,
      isNewSession: !existingSession,
      model,
    });

    sessions.updateSession(senderId, workspace, run.response.session_id);
    sessions.setActiveWorkspace(senderId, workspace);

    if (run.response.pendingQuestion) {
      sessions.setPendingQuestion(senderId, workspace, run.response.pendingQuestion);
    }

    return run.composedMarkdown;
  }

  async function doPlan(senderId: string, workspace: string, prompt: string, model?: string): Promise<string> {
    if (!existsSync(workspace)) {
      return `Workspace does not exist: ${workspace}`;
    }

    if (sessions.hasPendingPlan(senderId, workspace)) {
      return [
        `There is already a pending plan for workspace: ${workspace}`,
        "Use cc_execute to proceed, cc_reset to discard, or cc_plan again to replace it.",
      ].join("\n");
    }

    const wsSession = sessions.getSession(senderId, workspace);
    const existingSession = wsSession?.claudeSessionId;

    api.logger.info(
      `[openclaw-cc-bridge] [plan] [${workspace}] "${prompt.slice(0, 50)}..." from ${senderId}`
    );

    ensureHookConfig(workspace);

    const run = await runManager.execute({
      prompt,
      workspace,
      sessionId: existingSession,
      isNewSession: !existingSession,
      promptLabel: "[plan]",
      permissionMode: "plan",
      model,
    });

    sessions.updateSession(senderId, workspace, run.response.session_id);
    sessions.setActiveWorkspace(senderId, workspace);
    sessions.setPendingPlan(senderId, workspace, true);

    let text = run.composedMarkdown;
    text += "\n\n---";
    text += "\nTo proceed: use cc_execute tool";
    text += "\nTo discard: use cc_reset tool";

    return text;
  }

  async function doExecute(senderId: string, workspace: string, notes?: string, model?: string): Promise<string> {
    if (!sessions.hasPendingPlan(senderId, workspace)) {
      return `No pending plan for workspace: ${workspace}\nUse cc_plan to create one first.`;
    }

    const wsSession = sessions.getSession(senderId, workspace);
    const existingSession = wsSession?.claudeSessionId;

    if (!existingSession) {
      return "Session lost. Use cc_plan to create a new plan.";
    }

    const executePrompt = notes
      ? `Proceed with the plan. Additional notes: ${notes}`
      : "Proceed with the plan.";

    api.logger.info(
      `[openclaw-cc-bridge] [execute] [${workspace}] resuming session ${existingSession} from ${senderId}`
    );

    sessions.setPendingPlan(senderId, workspace, false);

    try {
      ensureHookConfig(workspace);

      const run = await runManager.execute({
        prompt: executePrompt,
        workspace,
        sessionId: existingSession,
        model,
      });

      sessions.updateSession(senderId, workspace, run.response.session_id);

      return run.composedMarkdown;
    } catch (err) {
      sessions.setPendingPlan(senderId, workspace, true);
      throw err;
    }
  }

  function doWorkspace(senderId: string, path?: string): string {
    if (!path) {
      const activeWs = sessions.getActiveWorkspace(senderId);
      const allSessions = sessions.listSessions(senderId);

      const lines = [activeWs ? `Active workspace: ${activeWs}` : "No active workspace."];

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

      return lines.join("\n");
    }

    const absPath = resolve(path);

    if (!existsSync(absPath)) {
      return `Directory does not exist: ${absPath}`;
    }

    const previousActive = sessions.getActiveWorkspace(senderId);
    sessions.setActiveWorkspace(senderId, absPath);
    ensureHookConfig(absPath);

    const changed = previousActive !== absPath;
    const existingSession = sessions.getSession(senderId, absPath);
    const sessionInfo = existingSession
      ? `Existing session found (${existingSession.messageCount} messages).`
      : "No existing session. Next message starts a new conversation.";

    return changed
      ? `Active workspace set to: ${absPath}\n${sessionInfo}`
      : `Active workspace already set to: ${absPath}`;
  }

  function doReset(senderId: string, workspace?: string, all?: boolean): string {
    if (all) {
      const count = sessions.removeAllSessions(senderId);
      return count > 0
        ? `Reset ${count} workspace session(s). Next message starts fresh.`
        : "No active sessions to reset.";
    }

    const targetWs = workspace ? resolve(workspace) : sessions.getActiveWorkspace(senderId);
    if (!targetWs) {
      return "No active workspace to reset.";
    }

    const removed = sessions.removeSession(senderId, targetWs);
    return removed
      ? `Session reset for workspace: ${targetWs}\nNext message starts a new conversation.`
      : `No active session for workspace: ${targetWs}`;
  }

  function doStatus(senderId: string, workspace?: string): string {
    const activeWs = sessions.getActiveWorkspace(senderId);

    if (workspace) {
      const absWs = resolve(workspace);
      const ws = sessions.getSession(senderId, absWs);
      if (!ws) {
        return `No active session for workspace: ${absWs}`;
      }
      const active = ws.workspace === activeWs ? " (active)" : "";
      const lines = [
        `### ${ws.workspace}${active}`,
        `Session: ${ws.claudeSessionId || "(new)"}`,
        `Messages: ${ws.messageCount}`,
        `Last active: ${new Date(ws.lastActive).toISOString()}`,
      ];
      if (ws.pendingPlan) {
        lines.push("Plan: pending (use cc_execute to proceed)");
      }
      if (ws.pendingQuestion) {
        lines.push("Question: Claude is waiting for your reply (use cc_send to answer)");
      }
      return lines.join("\n");
    }

    const allSessions = sessions.listSessions(senderId);

    if (allSessions.length === 0) {
      return "No active sessions.\nUse cc_workspace to set a workspace.";
    }

    const lines = [activeWs ? `Active workspace: ${activeWs}` : "No active workspace.", ""];

    for (const ws of allSessions) {
      const active = ws.workspace === activeWs ? " (active)" : "";
      lines.push(`### ${ws.workspace}${active}`);
      lines.push(`Session: ${ws.claudeSessionId || "(new)"}`);
      lines.push(`Messages: ${ws.messageCount}`);
      lines.push(`Last active: ${new Date(ws.lastActive).toISOString()}`);
      if (ws.pendingPlan) {
        lines.push("Plan: pending (use cc_execute to proceed)");
      }
      if (ws.pendingQuestion) {
        lines.push("Question: Claude is waiting for your reply (use cc_send to answer)");
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // =====================================================================
  // Background service: Hook Inbox
  // =====================================================================

  api.registerService({
    id: "claude-hook-inbox",
    start: async () => {
      hookInbox.start();
      api.logger.info("[openclaw-cc-bridge] Hook inbox watcher started");
    },
    stop: async () => {
      eventStore.flush();
      hookInbox.stop();
      api.logger.info("[openclaw-cc-bridge] Hook inbox watcher stopped");
    },
  });

  // =====================================================================
  // Slash commands (user-facing via chat)
  // =====================================================================

  api.registerCommand({
    name: "cc",
    description: "Send a message to Claude Code for processing",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const { model, rest: argsAfterModel } = parseModelArg(ctx.args.trim());
      const { workspace, rest: prompt } = parseWorkspaceArg(
        argsAfterModel,
        sessions.getActiveWorkspace(ctx.senderId)
      );

      if (!prompt) {
        return {
          text: [
            "Usage: /cc [-m <model>] [-w <workspace>] <your message>",
            "Example: /cc fix the bug in auth.py",
            "Example: /cc -m opus -w /path/to/project fix the bug",
            `Models: ${VALID_MODELS.join(", ")}`,
            "",
            "Other commands:",
            "  /cc_plan <message>    — create a plan first (read-only)",
            "  /cc_execute           — execute a pending plan",
            "  /cc_workspace <path>  — set/list working directory",
            "  /cc_reset             — reset session(s)",
            "  /cc_status            — show all session info",
          ].join("\n"),
        };
      }

      if (!workspace) {
        return { text: "No active workspace. Use /cc_workspace <path> to set one, or /cc -w <path> <message>." };
      }

      try {
        return { text: await doSend(ctx.senderId, workspace, prompt, model) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] Error: ${msg}`);
        return { text: `Error from Claude Code: ${msg}` };
      }
    },
  });

  api.registerCommand({
    name: "cc_plan",
    description:
      "Ask Claude Code to analyze and create a plan (read-only, no modifications)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const { model, rest: argsAfterModel } = parseModelArg(ctx.args.trim());
      const { workspace, rest: prompt } = parseWorkspaceArg(
        argsAfterModel,
        sessions.getActiveWorkspace(ctx.senderId)
      );

      if (!prompt) {
        return {
          text: [
            "Usage: /cc_plan [-m <model>] [-w <workspace>] <your task description>",
            "Example: /cc_plan refactor the authentication module",
            "Example: /cc_plan -m opus refactor the authentication module",
            `Models: ${VALID_MODELS.join(", ")}`,
            "",
            "Claude will analyze the codebase and produce an implementation plan",
            "without making any changes. Review the plan, then:",
            "  /cc_execute           — execute the plan as-is",
            "  /cc_execute <notes>   — execute with additional instructions",
            "  /cc_reset             — discard the plan",
          ].join("\n"),
        };
      }

      if (!workspace) {
        return { text: "No active workspace. Use /cc_workspace <path> to set one, or /cc_plan -w <path> <message>." };
      }

      try {
        return { text: await doPlan(ctx.senderId, workspace, prompt, model) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] [plan] Error: ${msg}`);
        return { text: `Error from Claude Code (plan): ${msg}` };
      }
    },
  });

  api.registerCommand({
    name: "cc_execute",
    description: "Execute a previously created plan",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const { workspace, rest: additionalNotes } = parseWorkspaceArg(
        ctx.args.trim(),
        sessions.getActiveWorkspace(ctx.senderId)
      );

      if (!workspace) {
        return { text: "No active workspace. Use /cc_workspace <path> to set one, or /cc_execute -w <path>." };
      }

      try {
        return { text: await doExecute(ctx.senderId, workspace, additionalNotes || undefined) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] [execute] Error: ${msg}`);
        return { text: `Error executing plan: ${msg}` };
      }
    },
  });

  api.registerCommand({
    name: "cc_workspace",
    description: "Set or list working directories for Claude Code",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const rawPath = ctx.args.trim();
      return { text: doWorkspace(ctx.senderId, rawPath || undefined) };
    },
  });

  api.registerCommand({
    name: "cc_reset",
    description: "Reset Claude Code session(s)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const args = ctx.args.trim();

      if (args === "--all") {
        return { text: doReset(ctx.senderId, undefined, true) };
      }

      const wsMatch = args.match(/^(?:-w|--workspace)\s+(\S+)$/);
      if (wsMatch) {
        return { text: doReset(ctx.senderId, wsMatch[1]) };
      }

      if (!args) {
        return { text: doReset(ctx.senderId) };
      }

      return {
        text: [
          "Usage:",
          "  /cc_reset              — reset active workspace session",
          "  /cc_reset -w <path>    — reset specific workspace session",
          "  /cc_reset --all        — reset all workspace sessions",
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "cc_status",
    description: "Show Claude Code session status",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const { workspace: filterWs } = parseWorkspaceArg(ctx.args.trim(), "");
      return { text: doStatus(ctx.senderId, filterWs || undefined) };
    },
  });

  // =====================================================================
  // Agent tools (LLM-callable via registerTool)
  // =====================================================================

  const modelEnumDescription = `Model to use. Options: ${VALID_MODELS.join(", ")}. If omitted, uses the configured default or Claude CLI default.`;

  api.registerTool({
    name: "cc_send",
    description: "Send a message to Claude Code for processing. Use this to write, edit, fix, refactor code, run commands, or ask questions about a codebase.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The task or message for Claude Code" },
        workspace: { type: "string", description: "Workspace directory path. If omitted, uses the active workspace." },
        model: { type: "string", enum: VALID_MODELS, description: modelEnumDescription },
      },
      required: ["message"],
    },
    async execute(_id, params) {
      const message = params.message as string;
      const model = params.model as string | undefined;
      const workspace = (params.workspace as string | undefined)
        ? resolve(params.workspace as string)
        : sessions.getActiveWorkspace(AGENT_SENDER_ID);

      if (!workspace) {
        return textResult("No active workspace. Use cc_workspace tool to set one first.");
      }

      try {
        return textResult(await doSend(AGENT_SENDER_ID, workspace, message, model));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] [tool:cc_send] Error: ${msg}`);
        return textResult(`Error from Claude Code: ${msg}`);
      }
    },
  });

  api.registerTool({
    name: "cc_plan",
    description: "Ask Claude Code to analyze the codebase and create an implementation plan without making any changes (read-only). Use for complex or high-risk changes where you want to review before executing.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The task description to plan for" },
        workspace: { type: "string", description: "Workspace directory path. If omitted, uses the active workspace." },
        model: { type: "string", enum: VALID_MODELS, description: modelEnumDescription },
      },
      required: ["message"],
    },
    async execute(_id, params) {
      const message = params.message as string;
      const model = params.model as string | undefined;
      const workspace = (params.workspace as string | undefined)
        ? resolve(params.workspace as string)
        : sessions.getActiveWorkspace(AGENT_SENDER_ID);

      if (!workspace) {
        return textResult("No active workspace. Use cc_workspace tool to set one first.");
      }

      try {
        return textResult(await doPlan(AGENT_SENDER_ID, workspace, message, model));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] [tool:cc_plan] Error: ${msg}`);
        return textResult(`Error from Claude Code (plan): ${msg}`);
      }
    },
  });

  api.registerTool({
    name: "cc_execute",
    description: "Execute a previously created plan. Must call cc_plan first to create a plan before using this tool.",
    parameters: {
      type: "object",
      properties: {
        notes: { type: "string", description: "Optional additional instructions or adjustments for the execution" },
        workspace: { type: "string", description: "Workspace directory path. If omitted, uses the active workspace." },
        model: { type: "string", enum: VALID_MODELS, description: modelEnumDescription },
      },
    },
    async execute(_id, params) {
      const notes = params.notes as string | undefined;
      const model = params.model as string | undefined;
      const workspace = (params.workspace as string | undefined)
        ? resolve(params.workspace as string)
        : sessions.getActiveWorkspace(AGENT_SENDER_ID);

      if (!workspace) {
        return textResult("No active workspace. Use cc_workspace tool to set one first.");
      }

      try {
        return textResult(await doExecute(AGENT_SENDER_ID, workspace, notes, model));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        api.logger.error(`[openclaw-cc-bridge] [tool:cc_execute] Error: ${msg}`);
        return textResult(`Error executing plan: ${msg}`);
      }
    },
  });

  api.registerTool({
    name: "cc_workspace",
    description: "Set or list the active workspace directory for Claude Code sessions. Call without arguments to list all workspaces.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to set as active workspace. Omit to list current workspaces." },
      },
    },
    async execute(_id, params) {
      const path = params.path as string | undefined;
      return textResult(doWorkspace(AGENT_SENDER_ID, path));
    },
  });

  api.registerTool({
    name: "cc_reset",
    description: "Reset Claude Code session(s). Clears conversation history so the next message starts a fresh session.",
    parameters: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Workspace path to reset. If omitted, resets the active workspace." },
        all: { type: "boolean", description: "If true, reset all workspace sessions." },
      },
    },
    async execute(_id, params) {
      const workspace = params.workspace as string | undefined;
      const all = params.all as boolean | undefined;
      return textResult(doReset(AGENT_SENDER_ID, workspace, all));
    },
  });

  api.registerTool({
    name: "cc_status",
    description: "Show Claude Code session status including active workspace, session IDs, message counts, and pending plans.",
    parameters: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Show status for a specific workspace. If omitted, shows all sessions." },
      },
    },
    async execute(_id, params) {
      const workspace = params.workspace as string | undefined;
      return textResult(doStatus(AGENT_SENDER_ID, workspace));
    },
  });

  api.logger.info("[openclaw-cc-bridge] Plugin registered");
}
