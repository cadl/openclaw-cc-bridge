# openclaw-cc-bridge

OpenClaw plugin for controlling [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via chat platforms.

openclaw-cc-bridge bridges OpenClaw chat commands with Claude Code CLI, enabling users to send prompts, manage sessions, plan and execute code changes, and track tool usage directly from any OpenClaw-connected chat platform.

## Features

- **Chat-driven Claude Code** — Send prompts and receive results via `/cc` commands
- **Plan / Execute workflow** — Create read-only plans with `/cc_plan`, review, then execute with `/cc_execute`
- **Agent tools** — LLM-callable tools (`cc_send`, `cc_plan`, `cc_execute`, etc.) for AI agent integration
- **Pending question handling** — Claude Code's `AskUserQuestion` prompts are surfaced to chat; reply via `/cc`
- **Multi-workspace sessions** — Each sender can manage multiple workspace sessions independently
- **Session persistence** — Multi-turn conversations survive plugin restarts
- **File-based hook tracking** — Claude Code hook events (tool use, subagent lifecycle) captured via file-based inbox
- **Event persistence** — Full audit trail of stream events and hook events stored to disk
- **Timeout retry** — Automatic retry with `--resume` on Claude Code timeout (configurable max retries)
- **Debug UI** — Built-in web interface with WebSocket live streaming for development

## Commands

| Command | Description |
|---------|-------------|
| `/cc [-w <path>] <message>` | Send a prompt to Claude Code and receive the response |
| `/cc_plan [-w <path>] <message>` | Create a read-only plan (uses `--permission-mode plan`) |
| `/cc_execute [-w <path>] [notes]` | Execute a pending plan (optional additional notes) |
| `/cc_workspace [path]` | Set the active workspace, or list all workspace sessions |
| `/cc_reset [-w <path> \| --all]` | Reset session for active/specific/all workspaces |
| `/cc_status [-w <path>]` | Show session info (ID, workspace, message count, pending state) |

## Agent Tools

The plugin registers LLM-callable tools via `registerTool`, allowing AI agents to invoke Claude Code programmatically:

| Tool | Description |
|------|-------------|
| `cc_send` | Send a message to Claude Code for processing |
| `cc_plan` | Create a read-only implementation plan |
| `cc_execute` | Execute a previously created plan |
| `cc_workspace` | Set or list workspace directories |
| `cc_reset` | Reset session(s) |
| `cc_status` | Show session status |

All tools accept an optional `workspace` parameter. If omitted, they use the active workspace for the agent sender.

## Skills

The plugin ships an OpenClaw skill (`cc-bridge`) that lets the AI agent automatically recognize coding requests and invoke Claude Code without the user needing to type explicit slash commands. The skill is gated on `claude` CLI being available on PATH.

When the skill is loaded, users can simply describe what they want in natural language (e.g., "fix the auth bug in login.ts") and the AI agent will route the request to Claude Code via the appropriate tool.

## Quick Start

### Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- An OpenClaw instance

### Install

```bash
npm install
npm run build
```

### Configuration

Register the plugin in your OpenClaw setup. The plugin reads from `openclaw.plugin.json` and exports its entry point from `dist/plugin/index.js`.

**Plugin config (via OpenClaw API):**

| Key | Type | Description |
|-----|------|-------------|
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

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_CC_DATA_DIR` | `~/.openclaw/openclaw-cc-bridge` | Directory for session and event data |
| `DEBUG_PORT` | `3456` | Port for the debug UI server |

## Recommended Configuration

For the best experience, especially if you communicate in non-English languages, add the configuration snippets from [`SOUL_CONFIGURATION.md`](./SOUL_CONFIGURATION.md) to your OpenClaw workspace `SOUL.md` file.

This ensures:
- Your original language is preserved when sending prompts to Claude Code
- You receive complete, unmodified output from Claude Code sessions

## Architecture

```
Chat Platform
    │
    ▼
 OpenClaw ──► openclaw-cc-bridge plugin
                 │
                 ├── RunManager ──► orchestrates each execution
                 │     ├── ClaudeBridge ──► claude CLI (child process, NDJSON streaming)
                 │     ├── HookInbox ──► file-based hook capture (fs.watch + polling)
                 │     └── EventStore ──► store/ (stream + hook events per session)
                 │
                 └── SessionManager ──► sessions.json (sender → multi-workspace sessions)
```

### Modules

| Module | Role |
|--------|------|
| `plugin/index.ts` | Plugin entry point; registers commands, agent tools, and the hook inbox service |
| `core/claude-bridge.ts` | Spawns Claude Code processes, parses NDJSON stream, handles timeout retry |
| `core/run-manager.ts` | Coordinates bridge, hook inbox, and event store per execution |
| `core/session-manager.ts` | Multi-workspace sender-to-session mapping persistence |
| `core/event-store.ts` | Persists stream and hook events with session indexing |
| `core/hook-inbox.ts` | File-based hook event capture via fs.watch + polling fallback |
| `core/compose-result.ts` | Markdown result composition (thinking, tools, plans, questions) |
| `debug/debug-server.ts` | Standalone debug server with HTTP API + WebSocket |
| `debug/debug-page.ts` | Inline HTML for the debug single-page application |

### Data Layout

```
~/.openclaw/openclaw-cc-bridge/
├── sessions.json                 # sender → multi-workspace session mappings
├── hook-inbox/
│   └── events.jsonl              # shared hook event inbox (watched by HookInbox)
└── store/
    ├── index.json                # session index
    └── sessions/
        └── <sessionId>/
            ├── meta.json         # session metadata (cost, duration, model, firstPrompt)
            ├── stream.jsonl      # raw NDJSON stream events
            └── hooks.jsonl       # hook callback events
```

## Development

```bash
# Watch mode
npm run dev

# Launch debug server (compile + start)
npm run debug
```

The debug server starts at `http://localhost:3456` and provides a web UI for sending prompts, viewing live events, inspecting session history, and testing plan/execute workflows.

## License

MIT
