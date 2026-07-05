#!/usr/bin/env python3
"""
Memory Monitor — lightweight macOS RAM usage tracker with web dashboard.
Zero external dependencies (Python stdlib only).

Usage:
    python3 memory_monitor.py              # Dashboard on http://localhost:8085
    python3 memory_monitor.py --port 9000  # Custom port
    python3 memory_monitor.py --interval 5 # Sample every 5 seconds (default: 10)
"""

import argparse
import json
import os
import re
import subprocess
import threading
import time
from collections import defaultdict
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn

# --- Configuration ---
MAX_HISTORY_POINTS = 360  # 1 hour at 10s intervals
PROCESS_GROUP_ALIASES = {
    "com.apple.Virtualization.VirtualMachine": "Docker VM",
    "com.docker.backend": "Docker",
    "Docker Desktop Helper": "Docker Desktop",
    "Docker Desktop Helper (Renderer)": "Docker Desktop",
    "Docker Desktop Helper (GPU)": "Docker Desktop",
    "Google Chrome Helper": "Chrome",
    "Google Chrome Helper (Renderer)": "Chrome",
    "Google Chrome Helper (GPU)": "Chrome",
    "Google Chrome": "Chrome",
    "com.apple.WebKit.WebContent": "WebKit",
    "com.apple.WebKit.Networking": "WebKit",
    "iTerm2": "iTerm2",
    "Code Helper": "VS Code",
    "Code Helper (Renderer)": "VS Code",
    "Code Helper (GPU)": "VS Code",
    "Electron": "Electron",
    "node": "Node.js",
    "python3": "Python",
    "python": "Python",
    "WindowServer": "WindowServer",
    "claude": "Claude Code",
    "Finder": "Finder",
    "Safari": "Safari",
    "Safari Web Content": "Safari",
    "Signal Helper": "Signal",
    "Signal Helper (Renderer)": "Signal",
    "Slack Helper": "Slack",
    "Slack Helper (Renderer)": "Slack",
    "Telegram": "Telegram",
}


def get_total_memory_bytes():
    result = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True)
    return int(result.stdout.strip())


def get_vm_stats():
    """Parse vm_stat for system-level memory breakdown."""
    result = subprocess.run(["vm_stat"], capture_output=True, text=True)
    lines = result.stdout.strip().split("\n")
    # First line has page size
    page_size = 16384
    m = re.search(r"page size of (\d+) bytes", lines[0])
    if m:
        page_size = int(m.group(1))

    stats = {}
    for line in lines[1:]:
        m = re.match(r"(.+?):\s+(\d+)\.", line)
        if m:
            stats[m.group(1).strip()] = int(m.group(2)) * page_size
    return stats


def get_memory_pressure():
    """Get memory pressure level from macOS."""
    try:
        result = subprocess.run(
            ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
            capture_output=True, text=True, timeout=5
        )
        level = int(result.stdout.strip())
        return {0: "normal", 1: "warning", 2: "urgent", 4: "critical"}.get(level, f"unknown({level})")
    except Exception:
        return "unknown"


def get_swap_usage():
    """Parse sysctl for swap usage."""
    try:
        result = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True, timeout=5)
        # "total = 6144.00M  used = 2048.00M  free = 4096.00M  (encrypted)"
        info = {}
        for part in result.stdout.strip().split("  "):
            part = part.strip()
            m = re.match(r"(\w+)\s*=\s*([\d.]+)M", part)
            if m:
                info[m.group(1)] = float(m.group(2)) * 1024 * 1024
        return info
    except Exception:
        return {}


def get_docker_container_stats():
    """Get per-container memory from docker stats. Returns list of {name, mem_bytes}."""
    try:
        docker_bin = "/usr/local/bin/docker"
        if not os.path.exists(docker_bin):
            docker_bin = "docker"
        result = subprocess.run(
            [docker_bin, "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return []
        containers = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            name = parts[0].strip()
            # Parse "1.602GiB / 4GiB" or "870.5MiB / 4GiB"
            usage_str = parts[1].split("/")[0].strip()
            mem_bytes = 0
            m = re.match(r"([\d.]+)\s*(GiB|MiB|KiB|B)", usage_str)
            if m:
                val = float(m.group(1))
                unit = m.group(2)
                if unit == "GiB":
                    mem_bytes = int(val * 1073741824)
                elif unit == "MiB":
                    mem_bytes = int(val * 1048576)
                elif unit == "KiB":
                    mem_bytes = int(val * 1024)
                else:
                    mem_bytes = int(val)
            containers.append({"name": name, "mem_bytes": mem_bytes})
        return containers
    except Exception:
        return []


def _get_pid_cwd(pid):
    """Get a process's working directory using macOS libproc."""
    try:
        import ctypes
        import ctypes.util
        libproc = ctypes.CDLL(ctypes.util.find_library('proc') or '/usr/lib/libproc.dylib')
        PROC_PIDVNODEPATHINFO = 9
        MAXPATHLEN = 1024

        class vip_path(ctypes.Structure):
            _fields_ = [('_pad', ctypes.c_char * 152), ('vip_path', ctypes.c_char * MAXPATHLEN)]

        class proc_vnodepathinfo(ctypes.Structure):
            _fields_ = [('pvi_cdir', vip_path), ('pvi_rdir', vip_path)]

        info = proc_vnodepathinfo()
        ret = libproc.proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0,
                                   ctypes.byref(info), ctypes.sizeof(info))
        if ret > 0:
            return info.pvi_cdir.vip_path.decode('utf-8', errors='replace').rstrip('\x00')
    except Exception:
        pass
    return None


def get_claude_instances():
    """Get individual Claude Code instances with their project directories."""
    instances = {}
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid,rss,comm"],
            capture_output=True, text=True
        )
        claude_pids = []
        for line in result.stdout.strip().split("\n")[1:]:
            parts = line.split(None, 2)
            if len(parts) < 3:
                continue
            comm = parts[2].strip()
            if os.path.basename(comm) == "claude":
                try:
                    claude_pids.append((int(parts[0]), int(parts[1]) * 1024))
                except ValueError:
                    pass

        for pid, rss_bytes in claude_pids:
            cwd = _get_pid_cwd(pid) or "unknown"
            project = os.path.basename(cwd) if cwd not in ("/", "unknown") else cwd
            label = f"Claude: {project}"
            if label in instances:
                instances[label]["rss_bytes"] += rss_bytes
                instances[label]["pids"] += 1
            else:
                instances[label] = {"rss_bytes": rss_bytes, "pids": 1, "cwd": cwd}
    except Exception:
        pass
    return instances


def get_process_memory():
    """Get per-process RSS using ps, grouped by application.
    Docker VM is replaced with per-container breakdown from docker stats.
    Claude Code instances are shown individually by project directory."""
    result = subprocess.run(
        ["ps", "-eo", "pid,rss,comm", "-r"],
        capture_output=True, text=True
    )
    groups = defaultdict(lambda: {"rss_bytes": 0, "pids": 0, "is_container": False})

    for line in result.stdout.strip().split("\n")[1:]:  # skip header
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        try:
            rss_kb = int(parts[1])
        except ValueError:
            continue
        comm = parts[2].strip()

        # Extract process name from full path
        name = os.path.basename(comm)

        # Try to match to a group alias
        group = None
        for pattern, alias in PROCESS_GROUP_ALIASES.items():
            if pattern in comm or pattern == name:
                group = alias
                break
        if group is None:
            group = name

        groups[group]["rss_bytes"] += rss_kb * 1024
        groups[group]["pids"] += 1

    # Replace "Docker VM" with per-container stats from docker stats
    # On macOS, the VM host RSS doesn't reflect actual container memory usage,
    # so we use docker stats which reports real in-VM memory per container.
    docker_containers = get_docker_container_stats()
    if docker_containers:
        groups.pop("Docker VM", None)  # remove the opaque VM entry
        for c in docker_containers:
            label = f"Docker: {c['name']}"
            groups[label]["rss_bytes"] = c["mem_bytes"]
            groups[label]["pids"] = 1
            groups[label]["is_container"] = True

    # Replace grouped "Claude Code" with individual instances by project
    claude_instances = get_claude_instances()
    if claude_instances:
        groups.pop("Claude Code", None)
        for label, info in claude_instances.items():
            groups[label]["rss_bytes"] = info["rss_bytes"]
            groups[label]["pids"] = info["pids"]

    # Sort by memory descending
    sorted_groups = sorted(groups.items(), key=lambda x: x[1]["rss_bytes"], reverse=True)
    return [
        {"name": name, "rss_bytes": info["rss_bytes"], "pids": info["pids"],
         "is_container": info.get("is_container", False)}
        for name, info in sorted_groups
    ]


# --- Data Store ---
class MemoryStore:
    def __init__(self, max_points=MAX_HISTORY_POINTS):
        self.max_points = max_points
        self.lock = threading.Lock()
        self.history = []  # [{timestamp, total, used, swap_used, top_processes: [...]}]
        self.latest = None

    def record(self):
        total = get_total_memory_bytes()
        vm = get_vm_stats()
        pressure = get_memory_pressure()
        swap = get_swap_usage()
        processes = get_process_memory()

        # "used" = active + inactive + speculative + wired
        active = vm.get("Pages active", 0)
        inactive = vm.get("Pages inactive", 0)
        speculative = vm.get("Pages speculative", 0)
        wired = vm.get("Pages wired down", 0)
        compressed = vm.get("Pages occupied by compressor", 0)
        free = vm.get("Pages free", 0)
        app_memory = active + inactive + speculative
        used = active + wired + compressed

        snapshot = {
            "timestamp": time.time(),
            "total_bytes": total,
            "used_bytes": used,
            "app_bytes": app_memory,
            "wired_bytes": wired,
            "compressed_bytes": compressed,
            "free_bytes": free,
            "swap_used_bytes": swap.get("used", 0),
            "swap_total_bytes": swap.get("total", 0),
            "pressure": pressure,
            "processes": processes[:30],  # top 30
        }

        with self.lock:
            self.latest = snapshot
            self.history.append({
                "timestamp": snapshot["timestamp"],
                "used_bytes": used,
                "app_bytes": app_memory,
                "wired_bytes": wired,
                "compressed_bytes": compressed,
                "swap_used_bytes": snapshot["swap_used_bytes"],
                "top5": [{"name": p["name"], "rss_bytes": p["rss_bytes"]} for p in processes[:5]],
            })
            if len(self.history) > self.max_points:
                self.history = self.history[-self.max_points:]

    def get_latest(self):
        with self.lock:
            return self.latest

    def get_history(self):
        with self.lock:
            return list(self.history)


# --- Sampling Thread ---
def sampler_loop(store, interval):
    while True:
        try:
            store.record()
        except Exception as e:
            print(f"[sampler] error: {e}")
        time.sleep(interval)


# --- HTTP Server ---
DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Monitor</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --purple: #bc8cff;
    --orange: #f0883e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif;
         background: var(--bg); color: var(--text); padding: 16px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
  .pressure-badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
  .pressure-normal { background: var(--green); color: #000; }
  .pressure-warning { background: var(--yellow); color: #000; }
  .pressure-urgent { background: var(--orange); color: #000; }
  .pressure-critical { background: var(--red); color: #fff; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .card h2 { font-size: 13px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }

  .stat-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
  .stat-label { color: var(--text2); }
  .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }

  .bar-outer { height: 8px; background: var(--border); border-radius: 4px; margin: 8px 0; overflow: hidden; }
  .bar-inner { height: 100%; border-radius: 4px; transition: width 0.5s ease; }

  .process-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .process-table th { text-align: left; color: var(--text2); font-weight: 500; padding: 6px 8px;
                       border-bottom: 1px solid var(--border); font-size: 12px; }
  .process-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); }
  .process-table tr:last-child td { border-bottom: none; }
  .process-bar { height: 4px; background: var(--accent); border-radius: 2px; min-width: 2px; }

  .chart-container { position: relative; height: 220px; }
  canvas { width: 100% !important; }

  .updated { font-size: 11px; color: var(--text2); text-align: right; margin-top: 8px; }

  .swap-warn { color: var(--yellow); font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<h1>Memory Monitor <span id="pressure" class="pressure-badge"></span></h1>

<div class="grid">
  <div class="card">
    <h2>System Memory</h2>
    <div class="bar-outer"><div id="mem-bar" class="bar-inner" style="width:0; background: var(--accent);"></div></div>
    <div id="mem-stats"></div>
  </div>
  <div class="card">
    <h2>Swap</h2>
    <div class="bar-outer"><div id="swap-bar" class="bar-inner" style="width:0; background: var(--purple);"></div></div>
    <div id="swap-stats"></div>
  </div>
</div>

<div class="grid">
  <div class="card" style="grid-column: 1 / -1;">
    <h2>Memory Over Time</h2>
    <div class="chart-container"><canvas id="history-chart"></canvas></div>
  </div>
</div>

<div class="card">
  <h2>Top Processes by Memory</h2>
  <table class="process-table">
    <thead><tr><th>#</th><th>Process</th><th>Memory</th><th>PIDs</th><th></th></tr></thead>
    <tbody id="process-tbody"></tbody>
  </table>
</div>

<div class="updated" id="updated"></div>

<script>
const fmt = (bytes) => {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
};
const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) : '0';

let chart = null;

function initChart() {
  const ctx = document.getElementById('history-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Used', data: [], borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
        { label: 'Wired', data: [], borderColor: '#f0883e', backgroundColor: 'rgba(240,136,62,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
        { label: 'Compressed', data: [], borderColor: '#bc8cff', backgroundColor: 'rgba(188,140,255,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
        { label: 'Swap Used', data: [], borderColor: '#d29922', borderDash: [4,2], fill: false, tension: 0.3, pointRadius: 0 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 300 },
      scales: {
        x: { display: true, grid: { color: '#30363d' }, ticks: { color: '#8b949e', maxTicksLimit: 8, font: { size: 10 } } },
        y: { display: true, grid: { color: '#30363d' }, ticks: { color: '#8b949e', font: { size: 10 },
              callback: v => fmt(v) }, beginAtZero: true }
      },
      plugins: {
        legend: { labels: { color: '#8b949e', boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + fmt(ctx.raw) } }
      }
    }
  });
}

function updateChart(history) {
  if (!chart) initChart();
  const labels = history.map(h => {
    const d = new Date(h.timestamp * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  });
  chart.data.labels = labels;
  chart.data.datasets[0].data = history.map(h => h.used_bytes);
  chart.data.datasets[1].data = history.map(h => h.wired_bytes);
  chart.data.datasets[2].data = history.map(h => h.compressed_bytes);
  chart.data.datasets[3].data = history.map(h => h.swap_used_bytes);
  chart.update('none');
}

function updateDashboard(data) {
  // Pressure badge
  const pb = document.getElementById('pressure');
  pb.textContent = data.pressure;
  pb.className = 'pressure-badge pressure-' + data.pressure;

  // Memory bar + stats
  const usedPct = pct(data.used_bytes, data.total_bytes);
  document.getElementById('mem-bar').style.width = usedPct + '%';
  const barColor = usedPct > 90 ? 'var(--red)' : usedPct > 75 ? 'var(--yellow)' : 'var(--accent)';
  document.getElementById('mem-bar').style.background = barColor;
  document.getElementById('mem-stats').innerHTML = `
    <div class="stat-row"><span class="stat-label">Used</span><span class="stat-value">${fmt(data.used_bytes)} (${usedPct}%)</span></div>
    <div class="stat-row"><span class="stat-label">App Memory</span><span class="stat-value">${fmt(data.app_bytes)}</span></div>
    <div class="stat-row"><span class="stat-label">Wired</span><span class="stat-value">${fmt(data.wired_bytes)}</span></div>
    <div class="stat-row"><span class="stat-label">Compressed</span><span class="stat-value">${fmt(data.compressed_bytes)}</span></div>
    <div class="stat-row"><span class="stat-label">Free</span><span class="stat-value">${fmt(data.free_bytes)}</span></div>
    <div class="stat-row"><span class="stat-label">Total</span><span class="stat-value">${fmt(data.total_bytes)}</span></div>
  `;

  // Swap bar + stats
  const swapPct = pct(data.swap_used_bytes, data.swap_total_bytes);
  document.getElementById('swap-bar').style.width = swapPct + '%';
  document.getElementById('swap-stats').innerHTML = `
    <div class="stat-row"><span class="stat-label">Used</span><span class="stat-value">${fmt(data.swap_used_bytes)} / ${fmt(data.swap_total_bytes)}</span></div>
  ` + (data.swap_used_bytes > 2147483648 ? '<div class="swap-warn">High swap usage — system may be slow</div>' : '');

  // Process table
  const tbody = document.getElementById('process-tbody');
  const maxRss = data.processes.length > 0 ? data.processes[0].rss_bytes : 1;
  tbody.innerHTML = data.processes.map((p, i) => `
    <tr>
      <td style="color:var(--text2)">${i + 1}</td>
      <td>${p.name}</td>
      <td style="font-variant-numeric:tabular-nums">${fmt(p.rss_bytes)}</td>
      <td style="color:var(--text2)">${p.pids}</td>
      <td style="width:30%"><div class="process-bar" style="width:${pct(p.rss_bytes, maxRss)}%"></div></td>
    </tr>
  `).join('');

  document.getElementById('updated').textContent = 'Updated: ' + new Date().toLocaleTimeString();
}

async function poll() {
  try {
    const [latest, history] = await Promise.all([
      fetch('/api/latest').then(r => r.json()),
      fetch('/api/history').then(r => r.json()),
    ]);
    updateDashboard(latest);
    updateChart(history);
  } catch (e) {
    console.error('Poll error:', e);
  }
}

poll();
setInterval(poll, 5000);
</script>
</body>
</html>"""


class MonitorHandler(SimpleHTTPRequestHandler):
    store = None

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(DASHBOARD_HTML.encode())
        elif self.path == "/api/latest":
            data = self.store.get_latest()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data or {}).encode())
        elif self.path == "/api/history":
            data = self.store.get_history()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass  # quiet


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description="Memory Monitor")
    parser.add_argument("--port", type=int, default=8085)
    parser.add_argument("--interval", type=int, default=10, help="Sampling interval in seconds")
    args = parser.parse_args()

    store = MemoryStore()
    MonitorHandler.store = store

    # Take first sample immediately
    store.record()

    # Start background sampler
    t = threading.Thread(target=sampler_loop, args=(store, args.interval), daemon=True)
    t.start()

    server = ThreadedHTTPServer(("127.0.0.1", args.port), MonitorHandler)
    print(f"Memory Monitor running at http://localhost:{args.port}")
    print(f"Sampling every {args.interval}s | Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.shutdown()


if __name__ == "__main__":
    main()
