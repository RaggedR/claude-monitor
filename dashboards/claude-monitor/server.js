const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 3200;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const STATS_CACHE = path.join(CLAUDE_DIR, 'stats-cache.json');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

// ── Pricing (per million tokens) ───────────────────────────────────────
const PRICING = {
  'claude-opus-4-6':            { input: 15, output: 75, cacheRead: 1.5,  cacheCreate: 18.75 },
  'claude-opus-4-5-20251101':   { input: 15, output: 75, cacheRead: 1.5,  cacheCreate: 18.75 },
  'claude-sonnet-4-6':          { input: 3,  output: 15, cacheRead: 0.3,  cacheCreate: 3.75  },
  'claude-sonnet-4-5-20250929': { input: 3,  output: 15, cacheRead: 0.3,  cacheCreate: 3.75  },
  'claude-haiku-4-5-20251001':  { input: 0.80, output: 4, cacheRead: 0.08, cacheCreate: 1.0  },
};

function getModelFamily(model) {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return 'unknown';
}

function calcCost(usage, model) {
  const p = PRICING[model];
  if (!p || !usage) return 0;
  const inp = (usage.input_tokens || 0) / 1e6 * p.input;
  const out = (usage.output_tokens || 0) / 1e6 * p.output;
  const cr  = (usage.cache_read_input_tokens || 0) / 1e6 * p.cacheRead;
  const cc  = (usage.cache_creation_input_tokens || 0) / 1e6 * p.cacheCreate;
  return inp + out + cr + cc;
}

// ── Session Index ──────────────────────────────────────────────────────
// Light metadata per JSONL file — built from first/last bytes at startup
const sessionIndex = new Map(); // sessionId -> metadata
const fileIndex = new Map();    // filePath -> { sessionId, size, mtime }

// Read first N bytes of a file to extract session metadata
function readHead(filePath, bytes = 4096) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(bytes);
  const bytesRead = fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  return buf.slice(0, bytesRead).toString('utf8');
}

// Read last N bytes of a file to get latest entries
function readTail(filePath, bytes = 8192) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const start = Math.max(0, stat.size - bytes);
  const buf = Buffer.alloc(Math.min(bytes, stat.size));
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.slice(0, bytesRead).toString('utf8');
}

function parseJsonlLines(text) {
  const lines = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { lines.push(JSON.parse(trimmed)); } catch {}
  }
  return lines;
}

// Extract quick metadata from head/tail of a JSONL file
function indexFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const headText = readHead(filePath, 8192); // read more to skip snapshots
    const headLines = parseJsonlLines(headText);
    if (headLines.length === 0) return null;

    // Skip file-history-snapshot and other non-session entries to find real first message
    const first = headLines.find(l => l.type === 'user' || l.type === 'assistant');
    if (!first) return null;

    // Use filename as sessionId (more reliable — files can contain multiple sessions)
    const fileBaseName = path.basename(filePath, '.jsonl');
    const sessionId = first.sessionId || fileBaseName;

    // Check if this is a subagent file
    const isSubagent = filePath.includes('/subagents/');
    const agentId = first.agentId || null;
    const agentSlug = first.slug || null;

    // Get project path and branch from first entry
    const project = first.cwd || first.project || '';
    const branch = first.gitBranch || '';
    const version = first.version || '';

    // Get first timestamp
    const firstTimestamp = first.timestamp
      ? (typeof first.timestamp === 'number' ? new Date(first.timestamp) : new Date(first.timestamp))
      : null;

    // Read tail for last timestamp and quick token sum
    const tailText = readTail(filePath);
    const tailLines = parseJsonlLines(tailText);

    let lastTimestamp = firstTimestamp;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let messageCount = 0;
    let model = '';
    let agentType = '';
    let agentDescription = '';

    for (const line of tailLines) {
      if (line.timestamp) {
        const ts = typeof line.timestamp === 'number' ? new Date(line.timestamp) : new Date(line.timestamp);
        if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
      }
      if (line.type === 'assistant' && line.message) {
        messageCount++;
        if (line.message.model) model = line.message.model;
        if (line.message.usage) {
          totalInputTokens += line.message.usage.input_tokens || 0;
          totalOutputTokens += line.message.usage.output_tokens || 0;
          totalCacheRead += line.message.usage.cache_read_input_tokens || 0;
          totalCacheCreate += line.message.usage.cache_creation_input_tokens || 0;
        }
      }
    }

    // Also scan head lines for token data and agent info
    for (const line of headLines) {
      if (line.type === 'assistant' && line.message) {
        if (line.message.model && !model) model = line.message.model;
        if (line.message.usage) {
          totalInputTokens += line.message.usage.input_tokens || 0;
          totalOutputTokens += line.message.usage.output_tokens || 0;
          totalCacheRead += line.message.usage.cache_read_input_tokens || 0;
          totalCacheCreate += line.message.usage.cache_creation_input_tokens || 0;
        }
      }
      // Extract agent spawn info from user messages in subagent files
      if (isSubagent && line.type === 'user' && line.message && line.message.content) {
        const content = typeof line.message.content === 'string'
          ? line.message.content
          : JSON.stringify(line.message.content);
        // First user message often contains the agent task description
        if (!agentDescription && content.length < 500) {
          agentDescription = content.slice(0, 200);
        }
      }
    }

    const duration = (firstTimestamp && lastTimestamp)
      ? lastTimestamp.getTime() - firstTimestamp.getTime()
      : 0;

    const isActive = (Date.now() - stat.mtimeMs) < 5 * 60 * 1000; // < 5 min ago

    const meta = {
      sessionId,
      filePath,
      project: project.replace(os.homedir(), '~'),
      branch,
      version,
      model,
      modelFamily: getModelFamily(model),
      firstTimestamp,
      lastTimestamp,
      duration,
      messageCount,
      isActive,
      isSubagent,
      agentId,
      agentSlug,
      agentType,
      agentDescription,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheRead: totalCacheRead,
        cacheCreate: totalCacheCreate,
        total: totalInputTokens + totalOutputTokens + totalCacheRead + totalCacheCreate,
      },
      cost: 0, // computed below
      fileSize: stat.size,
    };

    meta.cost = calcCost({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_read_input_tokens: totalCacheRead,
      cache_creation_input_tokens: totalCacheCreate,
    }, model);

    return meta;
  } catch (err) {
    return null;
  }
}

// Scan all JSONL files under ~/.claude/projects/
function buildIndex() {
  const start = Date.now();
  sessionIndex.clear();
  fileIndex.clear();

  if (!fs.existsSync(PROJECTS_DIR)) return;

  function walkDir(dir, depth = 0) {
    if (depth > 5) return; // don't recurse too deep
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath, depth + 1);
        } else if (entry.name.endsWith('.jsonl')) {
          const meta = indexFile(fullPath);
          if (meta) {
            // For main sessions (not subagents), add to sessionIndex
            if (!meta.isSubagent) {
              const existing = sessionIndex.get(meta.sessionId);
              if (!existing || meta.fileSize > existing.fileSize) {
                sessionIndex.set(meta.sessionId, meta);
              }
            }
            fileIndex.set(fullPath, meta);
          }
        }
      }
    } catch {}
  }

  walkDir(PROJECTS_DIR);
  console.log(`Index built: ${sessionIndex.size} sessions, ${fileIndex.size} files in ${Date.now() - start}ms`);
}

// ── LRU Cache for full session parses ──────────────────────────────────
class LRUCache {
  constructor(maxSize = 20, ttlMs = 60000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, time: Date.now() });
  }
}
const detailCache = new LRUCache(20, 60000);

// Full parse of a session JSONL for detail view
function parseSessionDetail(filePath) {
  const cached = detailCache.get(filePath);
  if (cached) return cached;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = parseJsonlLines(content);

    const messages = [];
    const agents = [];
    const toolCalls = {};
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
    const modelBreakdown = {};

    for (const line of lines) {
      const ts = line.timestamp
        ? (typeof line.timestamp === 'number' ? new Date(line.timestamp) : new Date(line.timestamp))
        : null;

      if (line.type === 'assistant' && line.message) {
        const usage = line.message.usage || {};
        const model = line.message.model || 'unknown';
        const inp = usage.input_tokens || 0;
        const out = usage.output_tokens || 0;
        const cr = usage.cache_read_input_tokens || 0;
        const cc = usage.cache_creation_input_tokens || 0;

        totalInput += inp;
        totalOutput += out;
        totalCacheRead += cr;
        totalCacheCreate += cc;

        if (!modelBreakdown[model]) {
          modelBreakdown[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, count: 0, cost: 0 };
        }
        modelBreakdown[model].input += inp;
        modelBreakdown[model].output += out;
        modelBreakdown[model].cacheRead += cr;
        modelBreakdown[model].cacheCreate += cc;
        modelBreakdown[model].count++;
        modelBreakdown[model].cost += calcCost(usage, model);

        // Check for tool_use blocks — agent spawns + other tools
        const content = line.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              const toolName = block.name || 'unknown';
              toolCalls[toolName] = (toolCalls[toolName] || 0) + 1;

              if (toolName === 'Agent' && block.input) {
                agents.push({
                  type: block.input.subagent_type || 'unknown',
                  description: block.input.description || '',
                  prompt: (block.input.prompt || '').slice(0, 300),
                  model: block.input.model || null,
                  timestamp: ts,
                });
              }
            }
          }
        }

        // Extract text preview from assistant content
        let assistantPreview = '';
        let toolNames = [];
        if (Array.isArray(content)) {
          assistantPreview = content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join(' ')
            .slice(0, 2000);
          toolNames = content
            .filter(b => b.type === 'tool_use')
            .map(b => {
              const name = b.name || 'unknown';
              // Add brief context for key tools
              if (name === 'Agent' && b.input) {
                return { tool: 'Agent', label: `Agent("${b.input.description || 'agent'}")`, description: b.input.description || '', subagentType: b.input.subagent_type || '' };
              }
              if (name === 'Bash' && b.input?.command) return `Bash: ${b.input.command.slice(0, 80)}`;
              if (name === 'Read' && b.input?.file_path) return `Read: ${b.input.file_path.split('/').slice(-2).join('/')}`;
              if (name === 'Write' && b.input?.file_path) return `Write: ${b.input.file_path.split('/').slice(-2).join('/')}`;
              if (name === 'Edit' && b.input?.file_path) return `Edit: ${b.input.file_path.split('/').slice(-2).join('/')}`;
              if (name === 'Grep' && b.input?.pattern) return `Grep: "${b.input.pattern}"`;
              if (name === 'Glob' && b.input?.pattern) return `Glob: ${b.input.pattern}`;
              return name;
            });
        } else if (typeof content === 'string') {
          assistantPreview = content.slice(0, 2000);
        }

        messages.push({
          type: 'assistant',
          timestamp: ts,
          model,
          preview: assistantPreview,
          toolNames,
          tokens: { input: inp, output: out, cacheRead: cr, cacheCreate: cc },
          cost: calcCost(usage, model),
          toolUseCount: toolNames.length,
        });
      } else if (line.type === 'user') {
        const content = line.message?.content;
        const preview = typeof content === 'string'
          ? content.slice(0, 2000)
          : Array.isArray(content)
            ? content.filter(b => b.type === 'text').map(b => b.text).join(' ').slice(0, 2000)
            : '';
        messages.push({
          type: 'user',
          timestamp: ts,
          preview,
        });
      }
    }

    const firstTs = messages.find(m => m.timestamp)?.timestamp;
    const lastTs = [...messages].reverse().find(m => m.timestamp)?.timestamp;

    const result = {
      messages,
      agents,
      toolCalls,
      totalTokens: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheCreate: totalCacheCreate },
      totalCost: calcCost({
        input_tokens: totalInput, output_tokens: totalOutput,
        cache_read_input_tokens: totalCacheRead, cache_creation_input_tokens: totalCacheCreate,
      }, Object.keys(modelBreakdown).sort((a, b) => modelBreakdown[b].count - modelBreakdown[a].count)[0] || ''),
      modelBreakdown,
      duration: (firstTs && lastTs) ? lastTs.getTime() - firstTs.getTime() : 0,
      messageCount: messages.length,
    };

    // Recalculate total cost across all models
    result.totalCost = Object.values(modelBreakdown).reduce((s, m) => s + m.cost, 0);

    detailCache.set(filePath, result);
    return result;
  } catch (err) {
    return null;
  }
}

// ── SSE ────────────────────────────────────────────────────────────────
const sseClients = new Set();
const fileOffsets = new Map();   // filePath -> byte offset
const debounceTimers = new Map(); // filePath -> timeout

function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

function handleFileChange(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const prevOffset = fileOffsets.get(filePath) || 0;
    if (stat.size <= prevOffset) return;

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - prevOffset);
    fs.readSync(fd, buf, 0, buf.length, prevOffset);
    fs.closeSync(fd);
    fileOffsets.set(filePath, stat.size);

    const newLines = parseJsonlLines(buf.toString('utf8'));
    const meta = fileIndex.get(filePath);

    for (const line of newLines) {
      if (line.type === 'assistant' && line.message) {
        const usage = line.message.usage || {};
        const model = line.message.model || '';

        // Update index metadata
        if (meta) {
          meta.messageCount++;
          meta.tokens.input += usage.input_tokens || 0;
          meta.tokens.output += usage.output_tokens || 0;
          meta.tokens.cacheRead += usage.cache_read_input_tokens || 0;
          meta.tokens.cacheCreate += usage.cache_creation_input_tokens || 0;
          meta.tokens.total = meta.tokens.input + meta.tokens.output + meta.tokens.cacheRead + meta.tokens.cacheCreate;
          meta.cost = calcCost({
            input_tokens: meta.tokens.input, output_tokens: meta.tokens.output,
            cache_read_input_tokens: meta.tokens.cacheRead, cache_creation_input_tokens: meta.tokens.cacheCreate,
          }, meta.model || model);
          meta.isActive = true;
          meta.lastTimestamp = new Date();
          if (model) meta.model = model;
          meta.modelFamily = getModelFamily(model || meta.model);
        }

        broadcastSSE('new-message', {
          sessionId: meta?.sessionId || line.sessionId,
          model,
          modelFamily: getModelFamily(model),
          tokens: usage,
          cost: calcCost(usage, model),
          isSubagent: meta?.isSubagent || false,
          agentId: meta?.agentId || null,
        });

        // Check for agent spawns
        if (Array.isArray(line.message.content)) {
          for (const block of line.message.content) {
            if (block.type === 'tool_use' && block.name === 'Agent' && block.input) {
              broadcastSSE('agent-spawn', {
                sessionId: meta?.sessionId || line.sessionId,
                type: block.input.subagent_type || 'unknown',
                description: block.input.description || '',
                model: block.input.model || null,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    if (meta) {
      broadcastSSE('session-update', {
        sessionId: meta.sessionId,
        messageCount: meta.messageCount,
        tokens: meta.tokens,
        cost: meta.cost,
        isActive: meta.isActive,
      });
    }
  } catch {}
}

function debouncedFileChange(filePath) {
  if (debounceTimers.has(filePath)) {
    clearTimeout(debounceTimers.get(filePath));
  }
  debounceTimers.set(filePath, setTimeout(() => {
    debounceTimers.delete(filePath);
    handleFileChange(filePath);
  }, 500));
}

// Set up file watchers on project directories
function setupWatchers() {
  if (!fs.existsSync(PROJECTS_DIR)) return;

  try {
    // Watch the projects directory recursively
    fs.watch(PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      const fullPath = path.join(PROJECTS_DIR, filename);
      if (!fs.existsSync(fullPath)) return;

      // If this is a new file we haven't seen, index it
      if (!fileIndex.has(fullPath)) {
        const meta = indexFile(fullPath);
        if (meta) {
          if (!meta.isSubagent) {
            sessionIndex.set(meta.sessionId, meta);
          }
          fileIndex.set(fullPath, meta);
          fileOffsets.set(fullPath, meta.fileSize);

          if (meta.isSubagent) {
            // New subagent detected — broadcast with agentId for detail linking
            broadcastSSE('agent-spawn', {
              sessionId: meta.sessionId,
              agentId: meta.agentId,
              agentSlug: meta.agentSlug,
              type: meta.agentType || meta.modelFamily || 'agent',
              description: meta.agentDescription || meta.agentSlug || '',
              model: meta.model,
              project: meta.project,
              timestamp: new Date().toISOString(),
            });
          } else {
            broadcastSSE('new-session', {
              sessionId: meta.sessionId,
              project: meta.project,
              branch: meta.branch,
            });
          }
        }
      }

      debouncedFileChange(fullPath);
    });
  } catch (err) {
    console.error('Failed to set up watchers:', err.message);
  }
}

// ── API Routes ─────────────────────────────────────────────────────────

// Serve static files
app.use(express.static(__dirname));

// Session list
app.get('/api/sessions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const sessions = [...sessionIndex.values()]
    .sort((a, b) => {
      // Active first, then by recency
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      const aTime = a.lastTimestamp ? a.lastTimestamp.getTime() : 0;
      const bTime = b.lastTimestamp ? b.lastTimestamp.getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, limit)
    .map(s => ({
      sessionId: s.sessionId,
      project: s.project,
      branch: s.branch,
      model: s.model,
      modelFamily: s.modelFamily,
      firstTimestamp: s.firstTimestamp,
      lastTimestamp: s.lastTimestamp,
      duration: s.duration,
      messageCount: s.messageCount,
      tokens: s.tokens,
      cost: s.cost,
      isActive: s.isActive,
      fileSize: s.fileSize,
    }));

  // Refresh isActive for returned sessions
  for (const s of sessions) {
    const meta = sessionIndex.get(s.sessionId);
    if (meta) {
      try {
        const stat = fs.statSync(meta.filePath);
        meta.isActive = (Date.now() - stat.mtimeMs) < 5 * 60 * 1000;
        s.isActive = meta.isActive;
      } catch {}
    }
  }

  res.json({ sessions, total: sessionIndex.size });
});

// Session detail
app.get('/api/sessions/:id', (req, res) => {
  const meta = sessionIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Session not found' });

  const detail = parseSessionDetail(meta.filePath);
  if (!detail) return res.status(500).json({ error: 'Failed to parse session' });

  res.json({
    sessionId: meta.sessionId,
    project: meta.project,
    branch: meta.branch,
    ...detail,
  });
});

// Stats from cache + computed costs
app.get('/api/stats', (req, res) => {
  try {
    const raw = fs.existsSync(STATS_CACHE) ? JSON.parse(fs.readFileSync(STATS_CACHE, 'utf8')) : {};

    // Compute cost per model from modelUsage
    const modelCosts = {};
    if (raw.modelUsage) {
      for (const [model, usage] of Object.entries(raw.modelUsage)) {
        modelCosts[model] = {
          ...usage,
          family: getModelFamily(model),
          cost: calcCost({
            input_tokens: usage.inputTokens || 0,
            output_tokens: usage.outputTokens || 0,
            cache_read_input_tokens: usage.cacheReadInputTokens || 0,
            cache_creation_input_tokens: usage.cacheCreationInputTokens || 0,
          }, model),
        };
      }
    }

    // Compute daily costs
    const dailyCosts = (raw.dailyModelTokens || []).map(day => {
      let dayCost = 0;
      const byFamily = {};
      for (const [model, tokens] of Object.entries(day.tokensByModel || {})) {
        // tokens in dailyModelTokens is just output_tokens count
        const family = getModelFamily(model);
        const p = PRICING[model];
        const cost = p ? (tokens / 1e6 * p.output) : 0;
        dayCost += cost;
        byFamily[family] = (byFamily[family] || 0) + tokens;
      }
      return { date: day.date, cost: dayCost, tokensByFamily: byFamily, totalTokens: Object.values(day.tokensByModel || {}).reduce((a, b) => a + b, 0) };
    });

    // Today's stats from live index
    const today = new Date().toISOString().slice(0, 10);
    let todayTokens = 0;
    let todayCost = 0;
    let todayActiveSessions = 0;
    let todayAgents = 0;

    for (const meta of sessionIndex.values()) {
      if (meta.lastTimestamp && meta.lastTimestamp.toISOString().slice(0, 10) === today) {
        todayTokens += meta.tokens.total;
        todayCost += meta.cost;
        if (meta.isActive) todayActiveSessions++;
      }
    }
    for (const meta of fileIndex.values()) {
      if (meta.isSubagent && meta.lastTimestamp && meta.lastTimestamp.toISOString().slice(0, 10) === today) {
        todayAgents++;
      }
    }

    // Rolling 5-hour message count from history.jsonl (Max plan rate limit window)
    let msgs5h = 0;
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        // Read last portion of history file for recent messages
        const histTail = readTail(HISTORY_FILE, 64 * 1024); // last 64KB
        const histLines = parseJsonlLines(histTail);
        for (const line of histLines) {
          if (line.timestamp && line.timestamp > fiveHoursAgo) {
            msgs5h++;
          }
        }
      }
    } catch {}

    // Max 20x plan: ~900 messages per 5-hour window
    const maxPlanLimit = 900;
    const usagePct = Math.min(100, (msgs5h / maxPlanLimit) * 100);

    res.json({
      ...raw,
      modelCosts,
      dailyCosts,
      today: {
        date: today,
        tokens: todayTokens,
        cost: todayCost,
        activeSessions: todayActiveSessions,
        agentsSpawned: todayAgents,
      },
      rateLimit: {
        plan: 'Max 20x',
        windowHours: 5,
        messagesInWindow: msgs5h,
        estimatedLimit: maxPlanLimit,
        usagePercent: Math.round(usagePct),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agent list
app.get('/api/agents', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const agents = [...fileIndex.values()]
    .filter(m => m.isSubagent)
    .sort((a, b) => {
      const aTime = a.lastTimestamp ? a.lastTimestamp.getTime() : 0;
      const bTime = b.lastTimestamp ? b.lastTimestamp.getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, limit)
    .map(a => ({
      sessionId: a.sessionId,
      agentId: a.agentId,
      agentSlug: a.agentSlug,
      project: a.project,
      model: a.model,
      modelFamily: a.modelFamily,
      firstTimestamp: a.firstTimestamp,
      lastTimestamp: a.lastTimestamp,
      duration: a.duration,
      messageCount: a.messageCount,
      tokens: a.tokens,
      cost: a.cost,
      isActive: a.isActive,
      description: a.agentDescription,
    }));

  res.json({ agents, total: [...fileIndex.values()].filter(m => m.isSubagent).length });
});

// Find agents belonging to a session
app.get('/api/sessions/:id/agents', (req, res) => {
  const sessionId = req.params.id;
  const agents = [...fileIndex.values()]
    .filter(m => m.isSubagent && m.sessionId === sessionId)
    .sort((a, b) => {
      const aTime = a.firstTimestamp ? a.firstTimestamp.getTime() : 0;
      const bTime = b.firstTimestamp ? b.firstTimestamp.getTime() : 0;
      return aTime - bTime;
    })
    .map(a => ({
      agentId: a.agentId,
      agentSlug: a.agentSlug,
      model: a.model,
      modelFamily: a.modelFamily,
      firstTimestamp: a.firstTimestamp,
      duration: a.duration,
      messageCount: a.messageCount,
      tokens: a.tokens,
      cost: a.cost,
      description: a.agentDescription,
    }));
  res.json({ agents });
});

// Agent detail — full parse of a subagent JSONL
app.get('/api/agents/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  // Find the file by agentId
  const meta = [...fileIndex.values()].find(m => m.isSubagent && m.agentId === agentId);
  if (!meta) return res.status(404).json({ error: 'Agent not found' });

  const detail = parseSessionDetail(meta.filePath);
  if (!detail) return res.status(500).json({ error: 'Failed to parse agent log' });

  res.json({
    agentId: meta.agentId,
    agentSlug: meta.agentSlug,
    sessionId: meta.sessionId,
    project: meta.project,
    model: meta.model,
    modelFamily: meta.modelFamily,
    description: meta.agentDescription,
    ...detail,
  });
});

// SSE endpoint
app.get('/api/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); sseClients.delete(res); }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

// ── Startup ────────────────────────────────────────────────────────────
console.log('Building session index...');
buildIndex();

// Initialize file offsets to current sizes (only track new data)
for (const [filePath, meta] of fileIndex) {
  fileOffsets.set(filePath, meta.fileSize);
}

setupWatchers();

// Periodically refresh isActive status
setInterval(() => {
  for (const [, meta] of sessionIndex) {
    try {
      const stat = fs.statSync(meta.filePath);
      meta.isActive = (Date.now() - stat.mtimeMs) < 5 * 60 * 1000;
    } catch {}
  }
}, 60000);

app.listen(PORT, () => {
  console.log(`Claude Monitor running at http://localhost:${PORT}`);
});
