---
name: claude-code
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

## Commands

### Direct execution

Send a task to Claude Code for immediate processing:

```
/cc <message>
/cc -w /path/to/project <message>
```

Use `-w` to target a specific project directory. Without it, the active workspace is used.

Examples:
- `/cc fix the auth bug in login.ts`
- `/cc -w /home/user/myapp add input validation to the signup form`
- `/cc refactor the database module to use connection pooling`

### Plan-then-execute workflow

For complex or high-risk changes, create a read-only plan first:

```
/cc-plan <task description>
```

Claude Code analyzes the codebase without making modifications and produces an implementation plan. Then:

- `/cc-execute` — execute the plan as-is
- `/cc-execute <additional notes>` — execute with adjustments
- `/cc-reset` — discard the plan

Use this workflow when:
- The task involves significant refactoring or architecture changes
- The user wants to review before committing to changes
- The user says "plan", "outline", "what would it take to", or "how should I"

### Session management

Switch the active workspace:
```
/cc-workspace /path/to/project
/cc-workspace                     — list all workspace sessions
```

Reset sessions:
```
/cc-reset              — reset active workspace session
/cc-reset -w <path>    — reset specific workspace session
/cc-reset --all        — reset all sessions
```

Check status:
```
/cc-status             — show all session info
/cc-status -w <path>   — show specific workspace status
```

## Behavior notes

- Each user has a persistent session per workspace. Follow-up messages continue the conversation with full prior context.
- If Claude Code asks a question, reply with `/cc <answer>` to continue.
- Using `/cc` while a plan is pending discards the plan and processes the message directly.
- Suggest `/cc-workspace` when the user mentions a project path different from the active workspace.
- Suggest `/cc-reset` when context seems stale or Claude Code is confused by prior conversation.
