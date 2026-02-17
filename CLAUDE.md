# openclaw-cc-bridge

OpenClaw plugin that bridges chat platforms with Claude Code CLI, enabling chat-driven Claude Code execution with session persistence, plan/execute workflow, and real-time event tracking.

## Architecture

```
OpenClaw Chat Platform → OpenClaw API → openclaw-cc-bridge Plugin
  ├── RunManager      → orchestrates bridge, hooks, and event store per execution
  ├── ClaudeBridge    → spawns `claude` CLI as child process (NDJSON streaming)
  ├── SessionManager  → multi-workspace per-sender session persistence
  ├── EventStore      → session stream/hook event logging (store/)
  ├── HookInbox       → file-based hook capture with fs.watch (hook-inbox/)
  └── DebugServer     → standalone dev server with WebSocket UI (port 3456)
```

## Project Structure

```
skills/
└── cc-bridge/             — OpenClaw skill (AI agent auto-discovery)
    └── SKILL.md           — Skill definition with gating (requires claude CLI)
src/
├── plugin/
│   └── index.ts           — Plugin entry point, registers commands (/cc, /cc-plan, /cc-execute, /cc-workspace, /cc-reset, /cc-status)
├── core/
│   ├── claude-bridge.ts   — Claude Code process spawner and NDJSON stream parser
│   ├── run-manager.ts     — Execution orchestrator (coordinates bridge, hooks, events)
│   ├── session-manager.ts — Multi-workspace sender-to-session mapping persistence
│   ├── event-store.ts     — Event and stream logging to disk
│   ├── hook-inbox.ts      — File-based hook capture with fs.watch (replaces HTTP hook server)
│   └── compose-result.ts  — Markdown result formatting for chat output
└── debug/
    ├── debug-server.ts    — HTTP API + WebSocket server (port 3456)
    └── debug-page.ts      — Inline HTML debug UI
```

## Tech Stack

- TypeScript 5.7 (strict mode), targeting ES2022, CommonJS output
- Node.js 18+
- `ws` for WebSocket (debug UI)
- No test framework or linter configured yet

## Commands

```bash
npm run build    # tsc → dist/
npm run dev      # tsc --watch
npm run debug    # build + run debug server
```

## Plugin Config

Configured via OpenClaw's plugin config (`configSchema` in `openclaw.plugin.json`):

| Key | Type | Description |
|---|---|---|
| `model` | `string` | Default Claude model to use. Options: `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opusplan`. Can be overridden per-invocation via `-m` flag or `model` tool parameter. If omitted, uses Claude CLI default. |
| `env` | `Record<string, string>` | Environment variables passed to the Claude Code process. The plugin strips all `ANTHROPIC_*` and `CLAUDE_*` vars from the parent process env to prevent leakage, then merges these values in. Use this to set `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, etc. |
| `allowedTools` | `string[]` | Claude Code tool names to allow (e.g. `["Bash", "Read", "Write"]`). If omitted, defaults to `["Read", "Edit", "Write", "Bash", "Glob", "Grep"]`. |

Example config:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-api-relay.example.com",
    "ANTHROPIC_API_KEY": "sk-..."
  },
  "allowedTools": ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Task"]
}
```

> **Note:** If `ANTHROPIC_BASE_URL` points to a LAN address and the gateway runs as a macOS launchd agent, local network connections may be blocked by macOS Local Network Privacy. See [troubleshoot.md](./troubleshoot.md) for details.

## Environment Variables

- `OPENCLAW_CC_DATA_DIR` — Data persistence directory (default: `~/.openclaw/openclaw-cc-bridge`)
- `DEBUG_PORT` — Debug UI port (default: `3456`)

## Conventions

- All source in `src/`, compiled output in `dist/`
- Data persisted as JSON/JSONL files under `~/.openclaw/openclaw-cc-bridge/`
- Claude Code spawned with `--output-format stream-json --verbose` for NDJSON parsing
- Hook inbox: All Claude Code hooks append to a single `events.jsonl` file in `~/.openclaw/openclaw-cc-bridge/hook-inbox/`, watched by `HookInbox` via fs.watch + polling fallback. Event type is determined from the `hook_event_name` field in each payload. Config written to `.claude/settings.local.json` per workspace.
- Multi-workspace session model: each sender has an active workspace with independent session state (sessionId, pendingPlan, pendingQuestion)
- Session defaults are asymmetric: slash commands default to **resume**, agent tools default to **fresh**. Slash commands support `--new`/`-n` to force fresh; agent tools support `continue_session: true` to resume.
- RunManager coordinates ClaudeBridge + HookInbox + EventStore per execution, with 100ms post-delay for trailing hook events
