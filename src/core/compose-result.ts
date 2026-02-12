/**
 * Shared markdown composition for result output.
 * Used by RunManager, debug server (session replay), and OpenClaw plugin.
 */

import type { PendingQuestion } from "./claude-bridge";

export interface ToolActivity {
  toolName: string;
  summary: string;
  timestamp: number;
  /** Whether the tool invocation failed */
  failed?: boolean;
}

export interface SubagentActivity {
  agentType: string;
  event: "start" | "stop";
  timestamp: number;
}

export interface ComposeResultInput {
  /** Accumulated assistant text (thinking/reasoning) */
  thinkingText: string;
  /** Hook-tracked tool activities (Edit, Write, Bash only) */
  hookToolActivities: ToolActivity[];
  /** Hook-tracked subagent lifecycle events */
  subagentActivities?: SubagentActivity[];
  /** Final result string from Claude */
  result: string;
  /** Full plan content from ExitPlanMode (plan mode only) */
  planContent?: string;
  /** Pending question from AskUserQuestion (Claude wants user input) */
  pendingQuestion?: PendingQuestion;
  /** Optional metadata */
  meta?: {
    numTurns?: number;
    durationMs?: number;
    costUsd?: number;
  };
}

/**
 * Compose a formatted markdown string combining thinking process,
 * tool activity, and final result.
 */
export function composeResultMarkdown(input: ComposeResultInput): string {
  const sections: string[] = [];

  // Thinking process (collapsible)
  const thinking = input.thinkingText.trim();
  if (thinking) {
    sections.push(
      `<details>\n<summary>💭 Thinking Process</summary>\n\n${thinking}\n\n</details>`
    );
  }

  // Hook tool activities
  if (input.hookToolActivities.length > 0) {
    const items = input.hookToolActivities
      .map((t) => {
        const icon = t.failed ? "x" : "-";
        const prefix = t.failed ? "(failed) " : "";
        return `${icon} \`${t.toolName}\` ${prefix}${t.summary}`;
      })
      .join("\n");
    sections.push(`### Tool Activity\n\n${items}`);
  }

  // Subagent activities
  if (input.subagentActivities && input.subagentActivities.length > 0) {
    const items = input.subagentActivities
      .map((s) => `- ${s.event === "start" ? "Started" : "Finished"} \`${s.agentType}\` subagent`)
      .join("\n");
    sections.push(`### Subagent Activity\n\n${items}`);
  }

  // Plan content (from ExitPlanMode, takes precedence over brief result summary)
  if (input.planContent?.trim()) {
    sections.push(`### 📋 Plan\n\n${input.planContent.trim()}`);
  }

  // Final result (if plan content is present, show result as a collapsible summary)
  if (input.result.trim()) {
    if (input.planContent?.trim()) {
      sections.push(
        `<details>\n<summary>📝 Result Summary</summary>\n\n${input.result.trim()}\n\n</details>`
      );
    } else {
      sections.push(`### Result\n\n${input.result.trim()}`);
    }
  }

  // Pending question (AskUserQuestion — Claude wants user input)
  if (input.pendingQuestion) {
    const questionBlocks = input.pendingQuestion.questions.map((q) => {
      const optionLines = q.options.map(
        (o, i) => `${i + 1}. **${o.label}** — ${o.description}`
      );
      return `**${q.header}: ${q.question}**\n${optionLines.join("\n")}`;
    });
    sections.push(
      `### Claude is asking:\n\n${questionBlocks.join("\n\n")}\n\nReply with your choice to continue.`
    );
  }

  // Metadata footer
  const meta: string[] = [];
  if (input.meta?.numTurns) meta.push(`${input.meta.numTurns} turns`);
  if (input.meta?.durationMs)
    meta.push(`${(input.meta.durationMs / 1000).toFixed(1)}s`);
  if (input.meta?.costUsd) meta.push(`$${input.meta.costUsd.toFixed(4)}`);
  if (meta.length > 0) {
    sections.push(`---\n*${meta.join(" | ")}*`);
  }

  return sections.join("\n\n");
}

/**
 * Format a hook tool-use event into a ToolActivity.
 * Hook events have shape: { toolName, toolInput, ... }
 */
export function formatHookToolActivity(
  data: Record<string, unknown>,
  failed?: boolean
): ToolActivity {
  const toolName = (data.tool_name || data.toolName || "unknown") as string;
  const input = (data.tool_input || data.toolInput || {}) as Record<
    string,
    unknown
  >;

  let summary: string;
  switch (toolName) {
    case "Edit":
      summary = String(input.file_path || "");
      break;
    case "Write":
      summary = String(input.file_path || "");
      break;
    case "Bash":
      summary = String(input.command || "").slice(0, 80);
      break;
    default:
      summary = JSON.stringify(input).slice(0, 80);
  }

  return {
    toolName,
    summary,
    timestamp: (data.timestamp as number) || Date.now(),
    ...(failed && { failed }),
  };
}

/**
 * Format a hook subagent event into a SubagentActivity.
 */
export function formatHookSubagentActivity(
  data: Record<string, unknown>,
  event: "start" | "stop"
): SubagentActivity {
  return {
    agentType: (data.agent_type || data.agentType || "unknown") as string,
    event,
    timestamp: (data.timestamp as number) || Date.now(),
  };
}

/**
 * Reconstruct composedMarkdown from stored stream/hook events.
 * Used for session history replay (e.g. loading a past session in the debug UI).
 */
export function reconstructComposedMarkdown(
  streamEvents: Array<{ type?: string; data: Record<string, unknown> }>,
  hookEvents: Array<{ type?: string; data: Record<string, unknown> }>,
  meta?: { totalTurns?: number; totalDurationMs?: number; totalCostUsd?: number } | null
): string {
  let thinkingText = "";
  let resultText = "";
  let planContent: string | undefined;

  for (const ev of streamEvents) {
    const evType = ev.type || (ev.data?.type as string);
    if (evType === "assistant") {
      const message = ev.data?.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) ?? [];
      for (const block of content) {
        if (block.type === "text") {
          thinkingText += (block.text as string) || "";
        } else if (block.type === "tool_use" && block.name === "ExitPlanMode") {
          const input = block.input as Record<string, unknown> | undefined;
          const plan = input?.plan as string | undefined;
          if (plan) {
            planContent = plan;
          }
        }
      }
    } else if (evType === "result") {
      resultText = (ev.data?.result as string) || "";
    }
  }

  const hookActivities: ToolActivity[] = hookEvents
    .filter((e) => {
      const t = e.type || "unknown";
      return t === "tool-use" || t === "tool-failure";
    })
    .map((e) => formatHookToolActivity(e.data, e.type === "tool-failure"));

  const subagentActivities: SubagentActivity[] = hookEvents
    .filter((e) => {
      const t = e.type || "unknown";
      return t === "subagent-start" || t === "subagent-stop";
    })
    .map((e) =>
      formatHookSubagentActivity(
        e.data,
        e.type === "subagent-start" ? "start" : "stop"
      )
    );

  return composeResultMarkdown({
    thinkingText,
    hookToolActivities: hookActivities,
    subagentActivities,
    result: resultText,
    planContent,
    meta: {
      numTurns: meta?.totalTurns,
      durationMs: meta?.totalDurationMs,
      costUsd: meta?.totalCostUsd,
    },
  });
}
