# openclaw-cc-bridge

OpenClaw plugin that bridges chat platforms with Claude Code CLI, enabling chat-driven Claude Code execution with session persistence, plan/execute workflow, and real-time event tracking.

## Architecture

```
OpenClaw Chat Platform → OpenClaw API → openclaw-cc-bridge Plugin
  ├── RunManager      → orchestrates bridge, hooks, and event store per execution
  ├── ClaudeBridge    → spawns `claude` CLI as child process (NDJSON streaming)
  ├── SessionManager  → multi-workspace per-sender session persistence
  ├── EventStore      → session stream/hook event logging (store/)
  ├── HookServer      → local HTTP server on port 19960 for Claude Code webhook callbacks
  └── DebugServer     → standalone dev server with WebSocket UI (port 3456)
```

## Project Structure

```
skills/
└── claude-code/           — OpenClaw skill (AI agent auto-discovery)
    └── SKILL.md           — Skill definition with gating (requires claude CLI)
src/
├── plugin/
│   └── index.ts           — Plugin entry point, registers commands (/cc, /cc-plan, /cc-execute, /cc-workspace, /cc-reset, /cc-status)
├── core/
│   ├── claude-bridge.ts   — Claude Code process spawner and NDJSON stream parser
│   ├── run-manager.ts     — Execution orchestrator (coordinates bridge, hooks, events)
│   ├── session-manager.ts — Multi-workspace sender-to-session mapping persistence
│   ├── event-store.ts     — Event and stream logging to disk
│   ├── hook-server.ts     — HTTP hook server for Claude Code callbacks (port 19960)
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

## Environment Variables

- `OPENCLAW_CC_DATA_DIR` — Data persistence directory (default: `~/.openclaw/openclaw-cc-bridge`)
- `OPENCLAW_CC_HOOK_PORT` — Hook server port (default: `19960`)
- `DEBUG_PORT` — Debug UI port (default: `3456`)

## Conventions

- All source in `src/`, compiled output in `dist/`
- Data persisted as JSON/JSONL files under `~/.openclaw/openclaw-cc-bridge/`
- Claude Code spawned with `--output-format stream-json --verbose` for NDJSON parsing
- Hook server runs on fixed port 19960 on 127.0.0.1, writes config to `.claude/settings.local.json` in each workspace
- Multi-workspace session model: each sender has an active workspace with independent session state (sessionId, pendingPlan, pendingQuestion)
- RunManager coordinates ClaudeBridge + HookServer + EventStore per execution, with 200ms post-delay for trailing hook events
