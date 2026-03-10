# Claude Monitor

Local observability dashboard for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions — token usage, costs, rate limits, subagents, and live updates.

Reads the JSONL session transcripts that Claude Code writes to `~/.claude/projects/` and presents them as a live-updating web dashboard. No cloud, no telemetry — everything stays on your machine.

## Quick Start

```bash
git clone https://github.com/RaggedR/claude-monitor.git
cd claude-monitor
npm install
node server.js
# Open http://localhost:3200
```

Requires Node.js 18+ and an active Claude Code installation (the `~/.claude/` directory must exist).

## What You See

- **Today's summary** — total tokens, estimated cost, active sessions, agents spawned
- **Rate limit meter** — rolling 5-hour message count against your plan limit (Max 20x = ~900 messages)
- **Session list** — all sessions sorted by recency, with model, token count, cost, and active indicator
- **Session detail** — full message timeline with tool call chips (`Bash: npm install`, `Edit: server.js`, `Agent("explore codebase")`), per-message token breakdown, model-by-model cost split
- **Subagent tracking** — agent spawns appear as toast notifications; drill down from parent session to agent logs
- **Token usage chart** — daily token consumption over time, colored by model family
- **Activity heatmap** — hourly session activity (CSS-only, no charting library)
- **Model breakdown** — token and cost split across Opus, Sonnet, and Haiku

Everything updates in real-time via Server-Sent Events — open the dashboard while working and watch your own session stream in.

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Frontend | Single-file vanilla HTML/CSS/JS (dark GitHub theme) |
| Live updates | Server-Sent Events via `fs.watch` on JSONL files |
| Charts | Pure CSS (no charting library) |
| Build tools | None |

## How It Works

The `~/.claude/projects/` directory can grow to 1GB+ of JSONL across thousands of files. Parsing all of it on every request would be impractical. Instead:

1. **Startup index scan (~1-2s)** — reads the first 8KB and last 8KB of each JSONL file. Extracts session ID, project, branch, model, and a token sample from head/tail bytes. No full parse.
2. **Lazy detail parsing** — full JSONL parse happens only when you click into a specific session (`/api/sessions/:id`). Results are cached in an LRU cache (20 entries, 60s TTL).
3. **Incremental SSE** — tracks byte offset per file. On `fs.watch` events, reads only the new bytes appended since last check. Zero re-parsing.
4. **Debounce** — 500ms per file to batch the rapid writes that Claude Code produces during a single turn.
5. **Active detection** — a session is "active" if its JSONL file was modified less than 5 minutes ago.

## Data Sources

| Source | Path | What it provides |
|--------|------|-----------------|
| Session transcripts | `~/.claude/projects/*/*.jsonl` | Per-message tokens, model, agent spawns, tool calls |
| Subagent logs | `~/.claude/projects/*/*/subagents/agent-*.jsonl` | Per-agent token usage, message count, model |
| Stats cache | `~/.claude/stats-cache.json` | Pre-aggregated daily tokens by model, session counts |
| History | `~/.claude/history.jsonl` | Rolling message count for rate limit meter |

## API

| Route | Description |
|-------|-------------|
| `GET /api/sessions?limit=50` | Session list with tokens, cost, active status |
| `GET /api/sessions/:id` | Full session detail: message timeline, tool usage, cost breakdown |
| `GET /api/sessions/:id/agents` | Subagents belonging to a session |
| `GET /api/stats` | Aggregated stats + today's live totals + rate limit info |
| `GET /api/agents?limit=50` | Recent subagent spawns across all sessions |
| `GET /api/agents/:agentId` | Full subagent detail |
| `GET /api/sse` | SSE stream: `session-update`, `new-message`, `agent-spawn`, `new-session` events |

## Token Cost Calculation

Pricing per million tokens (March 2026):

| Model | Input | Output | Cache Read | Cache Create |
|-------|-------|--------|------------|--------------|
| Opus 4.6 | $15 | $75 | $1.50 | $18.75 |
| Sonnet 4.5 | $3 | $15 | $0.30 | $3.75 |
| Haiku 4.5 | $0.80 | $4 | $0.08 | $1.00 |

Note: token counts from the index scan are approximate (sampled from head/tail bytes). The session detail view parses the complete file for exact numbers.

## Shared Bulletin Board

This project is part of a multi-instance Claude Code workflow. Multiple Claude instances working across different projects communicate asynchronously via a shared bulletin board at `~/.claude/tmp/notes/`.

Any instance can drop a note there — a discovery, a question, a status update, something interesting. Notes follow the convention `YYYY-MM-DD-<short-topic>.md` and start with a one-line `> summary` for skimming. This is how the instance that *built* Claude Monitor left a note about the architecture decisions and the "snake eating its own tail" moment of watching the SSE endpoint capture events from its own session during development.

The bulletin board isn't part of Claude Monitor's codebase, but it's a key piece of the observability ecosystem — where the quantitative data in this dashboard meets the qualitative context of what each session was actually doing.

## Color Scheme

- Purple (`#a78bfa`) — Opus
- Green (`#58d68d`) — Sonnet
- Orange (`#f0883e`) — Haiku

## License

MIT
