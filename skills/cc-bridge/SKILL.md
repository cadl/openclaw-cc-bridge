---
name: cc-bridge
description: Use Claude Code to write, edit, fix, and refactor code in any project workspace. Supports direct execution, plan-then-execute workflow, and session management.
metadata: {"openclaw": {"requires": {"bins": ["claude"]}}}
---

## When to use

Use this skill when the user wants to:

- Write, edit, or refactor code in a project
- Fix bugs or resolve errors in a codebase
- Add features or functionality to an existing project
- Analyze code, explain architecture, or answer questions about a codebase
- Run commands, scripts, or tests in a workspace
- Review and plan changes before applying them

## Agent tools

The following tools are available for direct invocation:

### cc_send

Send a message to Claude Code for immediate processing.

Parameters:
- `message` (string, required) — The task or message for Claude Code
- `workspace` (string, optional) — Workspace directory path. If omitted, uses the active workspace.
- `model` (string, optional) — Model to use. Options: `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opusplan`. If omitted, uses configured default.

Use for: writing code, fixing bugs, refactoring, running commands, asking questions about a codebase.

### cc_plan

Create a read-only implementation plan without making any changes.

Parameters:
- `message` (string, required) — The task description to plan for
- `workspace` (string, optional) — Workspace directory path. If omitted, uses the active workspace.
- `model` (string, optional) — Model to use. Options: `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opusplan`. If omitted, uses configured default.

Use for: complex or high-risk changes where you want to review before executing. After creating a plan, use `cc_execute` to proceed or `cc_reset` to discard.

### cc_execute

Execute a previously created plan.

Parameters:
- `notes` (string, optional) — Additional instructions or adjustments for the execution
- `workspace` (string, optional) — Workspace directory path. If omitted, uses the active workspace.
- `model` (string, optional) — Model to use. Options: `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opusplan`. If omitted, uses configured default.

Must call `cc_plan` first to create a plan before using this tool.

### cc_workspace

Set or list the active workspace directory.

Parameters:
- `path` (string, optional) — Directory path to set as active workspace. Omit to list current workspaces.

Always set a workspace before using `cc_send` or `cc_plan` if no workspace is active.

### cc_reset

Reset Claude Code session(s), clearing conversation history.

Parameters:
- `workspace` (string, optional) — Workspace path to reset. If omitted, resets the active workspace.
- `all` (boolean, optional) — If true, reset all workspace sessions.

### cc_status

Show Claude Code session status.

Parameters:
- `workspace` (string, optional) — Show status for a specific workspace. If omitted, shows all sessions.

## Typical workflow

1. Set a workspace: `cc_workspace({ path: "/path/to/project" })`
2. For simple tasks: `cc_send({ message: "fix the auth bug in login.ts" })`
3. For complex tasks:
   - `cc_plan({ message: "refactor the authentication module" })`
   - Review the plan output
   - `cc_execute()` or `cc_execute({ notes: "also update the tests" })`
4. Follow-up messages continue the same session with full prior context.

## Behavior notes

- Each session is persistent per workspace. Follow-up calls continue the conversation.
- If Claude Code asks a question, respond with `cc_send({ message: "your answer" })`.
- Using `cc_send` while a plan is pending discards the plan and processes the message directly.
- Use `cc_reset` when context seems stale or Claude Code is confused by prior conversation.
- Model can be specified per-invocation or as a global default in plugin config. Per-invocation overrides the default. Available models: `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opusplan`.

## Output handling

**CRITICAL**: When you receive results from `cc_send`, `cc_plan`, or `cc_execute` tools, you MUST:
- Return the complete tool result to the user **exactly as received**, without any modification, summarization, or rephrasing
- Do NOT add your own analysis, commentary, or interpretation of the results
- Do NOT truncate, shorten, or omit any part of the output
- The tool output is already formatted for the user — present it verbatim as your response
