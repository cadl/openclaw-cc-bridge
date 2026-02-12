# openclaw-cc-bridge

OpenClaw plugin for controlling [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via chat platforms.

openclaw-cc-bridge bridges OpenClaw chat commands with Claude Code CLI, enabling users to send prompts, manage sessions, plan and execute code changes, and track tool usage directly from any OpenClaw-connected chat platform.

## Features

- **Chat-driven Claude Code** - Send prompts and receive results via `/cc` commands
- **Plan / Execute workflow** - Create read-only plans with `/cc-plan`, review, then execute with `/cc-execute`
- **Pending question handling** - Claude Code's `AskUserQuestion` prompts are surfaced to chat; reply via `/cc`
- **Multi-workspace sessions** - Each sender can manage multiple workspace sessions independently
- **Session persistence** - Multi-turn conversations survive plugin restarts
- **Real-time hook tracking** - Local webhook server captures Claude Code events (tool use, subagent lifecycle)
- **Event persistence** - Full audit trail of stream events and hook events stored to disk
- **Timeout retry** - Automatic retry with `--resume` on Claude Code timeout (configurable max retries)
- **Debug UI** - Built-in web interface with WebSocket live streaming for development

## Commands

| Command | Description |
|---------|-------------|
| `/cc [-w <path>] <message>` | Send a prompt to Claude Code and receive the response |
| `/cc-plan [-w <path>] <message>` | Create a read-only plan (uses `--permission-mode plan`) |
| `/cc-execute [-w <path>] [notes]` | Execute a pending plan (optional additional notes) |
| `/cc-workspace [path]` | Set the active workspace, or list all workspace sessions |
| `/cc-reset [-w <path> \| --all]` | Reset session for active/specific/all workspaces |
| `/cc-status [-w <path>]` | Show session info (ID, workspace, message count, pending state) |

## Skills

The plugin ships an OpenClaw skill (`claude-code`) that lets the AI agent automatically recognize coding requests and invoke Claude Code without the user needing to type explicit slash commands. The skill is gated on `claude` CLI being available on PATH.

When the skill is loaded, users can simply describe what they want in natural language (e.g., "fix the auth bug in login.ts") and the AI agent will route the request to Claude Code via the appropriate command.

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

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_CC_WORKSPACE` | `process.cwd()` | Default working directory for Claude Code |
| `OPENCLAW_CC_DATA_DIR` | `~/.openclaw/openclaw-cc-bridge` | Directory for session and event data |
| `OPENCLAW_CC_HOOK_PORT` | `19960` | Port for the hook callback server |
| `DEBUG_PORT` | `3456` | Port for the debug UI server |

**Plugin config (via OpenClaw API):**

| Key | Type | Description |
|-----|------|-------------|
| `workspace` | `string` | Default workspace path (overrides env) |
| `allowedTools` | `string[]` | Claude Code tools to allow (default: `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`) |

## Architecture

```
Chat Platform
    │
    ▼
 OpenClaw ──► openclaw-cc-bridge plugin
                 │
                 ├── RunManager ──► orchestrates each execution
                 │     ├── ClaudeBridge ──► claude CLI (child process, NDJSON streaming)
                 │     ├── HookServer ──► local HTTP on port 19960 (Claude Code webhooks)
                 │     └── EventStore ──► store/ (stream + hook events per session)
                 │
                 └── SessionManager ──► sessions.json (sender → multi-workspace sessions)
```

### Modules

| Module | Role |
|--------|------|
| `plugin/index.ts` | Plugin entry point; registers commands and the hook server service |
| `core/claude-bridge.ts` | Spawns Claude Code processes, parses NDJSON stream, handles timeout retry |
| `core/run-manager.ts` | Coordinates bridge, hook server, and event store per execution |
| `core/session-manager.ts` | Multi-workspace sender-to-session mapping persistence |
| `core/event-store.ts` | Persists stream and hook events with session indexing |
| `core/hook-server.ts` | HTTP server receiving Claude Code hook callbacks (port 19960) |
| `core/compose-result.ts` | Markdown result composition (thinking, tools, plans, questions) |
| `debug/debug-server.ts` | Standalone debug server with HTTP API + WebSocket |
| `debug/debug-page.ts` | Inline HTML for the debug single-page application |

### Data Layout

```
~/.openclaw/openclaw-cc-bridge/
├── sessions.json                 # sender → multi-workspace session mappings
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
