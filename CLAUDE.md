# Claude Monitor

> Local observability dashboard for Claude Code sessions — token usage, costs, agents, live updates.

## Quick Start

```bash
cd ~/git/dashboards/claude-monitor
npm install
node server.js
# Open http://localhost:3200
```

## Stack

- **Backend**: Node.js + Express (API + static files)
- **Frontend**: Single-file vanilla HTML/CSS/JS (dark GitHub theme)
- **Live updates**: Server-Sent Events via `fs.watch` on JSONL files
- **No build tools, no frontend frameworks**

## Data Sources

| Source | Path | What it provides |
|--------|------|-----------------|
| Session transcripts | `~/.claude/projects/*/*.jsonl` | Per-message tokens, model, agent spawns, tool calls |
| Subagent logs | `~/.claude/projects/*/*/subagents/agent-*.jsonl` | Per-agent token usage, message count, model |
| Stats cache | `~/.claude/stats-cache.json` | Pre-aggregated daily tokens by model, session counts, hourly activity |

## API Endpoints

| Route | Description |
|-------|-------------|
| `GET /api/sessions?limit=50` | Session list with tokens, cost, active status |
| `GET /api/sessions/:id` | Full session detail: message timeline, tool usage, cost breakdown |
| `GET /api/stats` | Stats cache + computed cost estimates + today's live totals |
| `GET /api/agents?limit=50` | Recent subagent spawns across all sessions |
| `GET /api/sse` | SSE stream: `session-update`, `new-message`, `agent-spawn`, `new-session` events |

## Performance Strategy

The `~/.claude/projects/` directory contains ~900MB of JSONL across ~360 files. The server handles this via:

1. **Startup index scan (~2s)**: Reads first 4KB + last 8KB of each JSONL file. Gets sessionId, project, branch from first message; latest timestamp and token sample from last message.
2. **Lazy detail parsing**: Full JSONL parse only on `/api/sessions/:id`. LRU cache (20 entries, 60s TTL).
3. **Incremental SSE reads**: Tracks byte offset per file. On `fs.watch` event, reads only new bytes. Zero re-parsing.
4. **Debounce**: 500ms per file to batch rapid writes.
5. **Active detection**: Session is "active" if JSONL modified < 5 minutes ago.

## Token Cost Calculation

Pricing per million tokens (March 2026):

| Model | Input | Output | Cache Read | Cache Create |
|-------|-------|--------|------------|--------------|
| Opus 4.6 | $15 | $75 | $1.50 | $18.75 |
| Sonnet 4.5 | $3 | $15 | $0.30 | $3.75 |
| Haiku 4.5 | $0.80 | $4 | $0.08 | $1.00 |

## Architecture Notes

- **Token counts from head/tail are approximate** — they sample from the first and last ~4-8KB of each file, not the full content. The detail view (`/api/sessions/:id`) parses the complete file for exact numbers.
- **SSE uses `fs.watch` with recursive option** (macOS FSEvents). File changes are debounced at 500ms per file to batch rapid JSONL appends.
- **CSS-only charts** — bar charts and heatmaps are pure CSS, no charting library needed.
- **Color scheme**: purple = Opus, green = Sonnet, orange = Haiku (matches Lyra dashboard palette).
