import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { runCommand } from "../process.mjs";

const DEFAULT_GRAPHIFY_OUT = "graphify-out";
const DEFAULT_QUERY_TOKEN_BUDGET = 2000;
const DEFAULT_QUERY_DEPTH = 2;
const DEFAULT_MEMORY_TOKEN_BUDGET = 1000;
const DEFAULT_MEMORY_LIMIT = 3;
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
const SUPPORTED_PROVIDERS = new Set(["graphify"]);

export function buildRecommendedContextGraphConfig(overrides = {}) {
  return {
    enabled: true,
    provider: "graphify",
    outputDir: DEFAULT_GRAPHIFY_OUT,
    graphPath: path.join(DEFAULT_GRAPHIFY_OUT, "graph.json"),
    updateStrategy: "workflow-end",
    updateTimeoutMs: 120000,
    backgroundSync: true,
    lockUpdates: true,
    staleLockMs: DEFAULT_LOCK_STALE_MS,
    recordPendingUpdates: true,
    queryTokenBudget: DEFAULT_QUERY_TOKEN_BUDGET,
    queryDepth: DEFAULT_QUERY_DEPTH,
    injectIntoPrompts: true,
    promptTokenBudget: DEFAULT_QUERY_TOKEN_BUDGET,
    promptQueryDepth: DEFAULT_QUERY_DEPTH,
    tokenBudgetByMode: {
      fast: 1200,
      balanced: 2000,
      architect: 4000
    },
    memoryRetrieval: true,
    maxMemoryEntries: DEFAULT_MEMORY_LIMIT,
    memoryTokenBudget: DEFAULT_MEMORY_TOKEN_BUDGET,
    saveExecutionMemory: true,
    ...overrides
  };
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => String(value)))];
}

function toWorkspaceRelative(cwd, filePath) {
  if (!filePath) {
    return null;
  }
  const normalized = String(filePath);
  if (!path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.relative(cwd, normalized) || path.basename(normalized);
}

function normalizeChangedFiles(cwd, files = []) {
  return unique(files)
    .map((filePath) => toWorkspaceRelative(cwd, filePath))
    .filter((filePath) => filePath && !filePath.startsWith("..") && filePath !== ".");
}

function graphPathFromConfig(cwd, config = {}) {
  const graphConfig = config.contextGraph ?? {};
  const outDir = graphConfig.outputDir ?? DEFAULT_GRAPHIFY_OUT;
  const graphPath = graphConfig.graphPath ?? path.join(outDir, "graph.json");
  return path.isAbsolute(graphPath) ? graphPath : path.join(cwd, graphPath);
}

function reportPathFromGraphPath(graphPath) {
  return path.join(path.dirname(graphPath), "GRAPH_REPORT.md");
}

function configuredGraphifyCommand(config = {}) {
  return config.contextGraph?.command ?? config.contextGraph?.pythonCommand ?? "python3";
}

function configuredGraphifyArgs(config = {}) {
  const args = config.contextGraph?.commandArgs;
  if (Array.isArray(args)) {
    return args.map((arg) => String(arg));
  }
  return ["-m", "graphify"];
}

function isEnabled(config = {}) {
  return config.contextGraph?.enabled === true;
}

function isNonEmptyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonSafe(filePath, fallback) {
  try {
    return readJsonIfExists(filePath) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function buildPythonGraphQueryScript({ graphPath, action, query, source, target, tokenBudget, depth }) {
  const payload = {
    graphPath,
    action,
    query,
    source,
    target,
    tokenBudget,
    depth
  };
  return `
import json
import sys
from pathlib import Path
from networkx.readwrite import json_graph

payload = ${JSON.stringify(payload)}
root = Path.cwd()
vendored = root / "graphify-7"
if vendored.exists():
    sys.path.insert(0, str(vendored))

try:
    from graphify.serve import _find_node, _query_graph_text, _score_nodes
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Graphify query helpers unavailable: {exc}"}))
    raise SystemExit(0)

graph_path = Path(payload["graphPath"])
if not graph_path.exists():
    print(json.dumps({"ok": False, "error": f"Graph not found: {graph_path}"}))
    raise SystemExit(0)

data = json.loads(graph_path.read_text(encoding="utf-8"))
if "links" not in data and "edges" in data:
    data = dict(data, links=data["edges"])
try:
    graph = json_graph.node_link_graph(data, edges="links")
except TypeError:
    graph = json_graph.node_link_graph(data)

action = payload["action"]
if action == "query":
    text = _query_graph_text(
        graph,
        payload.get("query") or "",
        depth=int(payload.get("depth") or 2),
        token_budget=int(payload.get("tokenBudget") or 2000),
    )
    print(json.dumps({"ok": True, "action": action, "text": text}))
elif action == "explain":
    node = _find_node(graph, payload.get("query") or "")
    if node is None:
        print(json.dumps({"ok": False, "error": "No matching graph node found."}))
    else:
        attrs = graph.nodes[node]
        neighbors = []
        for neighbor in list(graph.neighbors(node))[:20]:
            edge = graph.get_edge_data(node, neighbor, default={}) or {}
            neighbors.append({
                "id": str(neighbor),
                "label": str(graph.nodes[neighbor].get("label", neighbor)),
                "relation": str(edge.get("relation", "relates")),
                "source_file": str(graph.nodes[neighbor].get("source_file", "")),
            })
        print(json.dumps({
            "ok": True,
            "action": action,
            "node": {"id": str(node), **attrs},
            "neighbors": neighbors,
        }))
elif action == "path":
    import networkx as nx
    source_node = _find_node(graph, payload.get("source") or "")
    target_node = _find_node(graph, payload.get("target") or "")
    if source_node is None or target_node is None:
        print(json.dumps({"ok": False, "error": "Source or target node was not found."}))
    else:
        try:
            nodes = nx.shortest_path(graph, source_node, target_node)
            steps = []
            for left, right in zip(nodes, nodes[1:]):
                edge = graph.get_edge_data(left, right, default={}) or {}
                steps.append({
                    "source": str(left),
                    "source_label": str(graph.nodes[left].get("label", left)),
                    "target": str(right),
                    "target_label": str(graph.nodes[right].get("label", right)),
                    "relation": str(edge.get("relation", "relates")),
                })
            print(json.dumps({"ok": True, "action": action, "path": steps}))
        except nx.NetworkXNoPath:
            print(json.dumps({"ok": False, "error": "No graph path found."}))
else:
    print(json.dumps({"ok": False, "error": f"Unsupported graph action: {action}"}))
`;
}

function buildPythonRuntimeCheckScript() {
  return `
import importlib
import json
import sys
from pathlib import Path

root = Path.cwd()
vendored = root / "graphify-7"
if vendored.exists():
    sys.path.insert(0, str(vendored))

modules = ["graphify", "networkx", "tree_sitter"]
checks = {}
for name in modules:
    try:
        module = importlib.import_module(name)
        checks[name] = {
            "ok": True,
            "version": getattr(module, "__version__", None)
        }
    except Exception as exc:
        checks[name] = {
            "ok": False,
            "error": str(exc)
        }

print(json.dumps({
    "ok": all(item["ok"] for item in checks.values()),
    "checks": checks,
}))
`;
}

function parsePythonJson(result) {
  const output = String(result.stdout ?? "").trim();
  if (!output) {
    return {
      ok: false,
      error: String(result.stderr ?? "").trim() || `python exited with status ${result.status}`
    };
  }
  try {
    return JSON.parse(output.split(/\r?\n/).at(-1));
  } catch (error) {
    return {
      ok: false,
      error: `Graph query returned invalid JSON: ${error.message}`,
      rawOutput: output
    };
  }
}

function normalizeGraphData(data = {}) {
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.links) ? data.links : Array.isArray(data.edges) ? data.edges : [];
  const nodeMap = new Map();
  nodes.forEach((node, index) => {
    const id = String(node.id ?? node.key ?? node.name ?? `node_${index + 1}`);
    nodeMap.set(id, {
      ...node,
      id,
      label: String(node.label ?? node.name ?? id),
      source_file: String(node.source_file ?? node.file ?? "")
    });
  });
  const normalizedEdges = edges
    .map((edge) => ({
      ...edge,
      source: String(edge.source ?? edge._src ?? edge.from ?? ""),
      target: String(edge.target ?? edge._tgt ?? edge.to ?? ""),
      relation: String(edge.relation ?? edge.type ?? edge.kind ?? "relates")
    }))
    .filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target));
  return { nodes: [...nodeMap.values()], edges: normalizedEdges, nodeMap };
}

function queryTerms(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_.$/-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

function queryPhrases(text) {
  const value = String(text ?? "").toLowerCase();
  const quoted = [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim()).filter(Boolean);
  const normalized = value.replace(/"[^"]+"/g, " ").trim();
  return unique([...quoted, normalized].filter((phrase) => phrase.length > 3));
}

function pathSegments(filePath) {
  return String(filePath ?? "")
    .toLowerCase()
    .split(/[\\/._-]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 1);
}

function nodeDegree(edges, nodeId) {
  return edges.reduce((count, edge) => count + (edge.source === nodeId || edge.target === nodeId ? 1 : 0), 0);
}

function adjacency(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!map.has(edge.source)) {
      map.set(edge.source, []);
    }
    if (!map.has(edge.target)) {
      map.set(edge.target, []);
    }
    map.get(edge.source).push({ node: edge.target, edge });
    map.get(edge.target).push({ node: edge.source, edge });
  }
  return map;
}

function scoreGraphNode(node, terms, phrases, graph) {
  const label = String(node.label ?? "").toLowerCase();
  const sourceFile = String(node.source_file ?? "").toLowerCase();
  const id = String(node.id ?? "").toLowerCase();
  const metadata = [
    node.source_location,
    node.file_type,
    node.node_type,
    node.kind,
    node.type
  ].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (label === term) score += 18;
    if (label.includes(term)) score += 8;
    if (id.includes(term)) score += 5;
    if (sourceFile.includes(term)) score += 5;
    if (metadata.includes(term)) score += 2;
    if (pathSegments(sourceFile).includes(term)) score += 4;
  }
  for (const phrase of phrases) {
    if (label.includes(phrase)) score += 20;
    if (sourceFile.includes(phrase)) score += 10;
  }
  if (node.source_file) {
    score += 1;
  }
  score += Math.min(8, nodeDegree(graph.edges, node.id));
  return score;
}

function rankGraphNodes(graph, text) {
  const terms = queryTerms(text);
  const phrases = queryPhrases(text);
  if (terms.length === 0 && phrases.length === 0) {
    return [];
  }
  return graph.nodes
    .map((node) => ({ node, score: scoreGraphNode(node, terms, phrases, graph) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label));
}

function findBestNode(graph, text) {
  const ranked = rankGraphNodes(graph, text);
  return ranked[0]?.node ?? null;
}

function rankGraphEdges(graph, selectedNodeIds, terms) {
  const selected = new Set(selectedNodeIds);
  return graph.edges
    .filter((edge) => selected.has(edge.source) || selected.has(edge.target))
    .map((edge) => {
      const relation = String(edge.relation ?? "").toLowerCase();
      const source = graph.nodeMap.get(edge.source);
      const target = graph.nodeMap.get(edge.target);
      let score = selected.has(edge.source) && selected.has(edge.target) ? 6 : 2;
      for (const term of terms) {
        if (relation.includes(term)) score += 4;
        if (String(source?.label ?? "").toLowerCase().includes(term)) score += 2;
        if (String(target?.label ?? "").toLowerCase().includes(term)) score += 2;
      }
      return { edge, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.edge);
}

function truncateText(text, tokenBudget) {
  const limit = Math.max(200, Number(tokenBudget ?? DEFAULT_QUERY_TOKEN_BUDGET) * 3);
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n...truncated...` : value;
}

function scoreText(text, terms) {
  const haystack = String(text ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) {
      continue;
    }
    const matches = haystack.split(term).length - 1;
    score += matches > 0 ? Math.min(10, matches) : 0;
  }
  return score;
}

function recencyBoost(mtimeMs) {
  const ageDays = Math.max(0, (Date.now() - Number(mtimeMs || 0)) / 86_400_000);
  if (ageDays <= 1) return 8;
  if (ageDays <= 7) return 5;
  if (ageDays <= 30) return 2;
  return 0;
}

function safeReadText(filePath, limit = 20000) {
  try {
    const value = fs.readFileSync(filePath, "utf8");
    return value.length > limit ? value.slice(0, limit) : value;
  } catch {
    return "";
  }
}

function stripFrontmatter(text) {
  return String(text ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function acquireFileLock(lockPath, options = {}) {
  const staleMs = Number(options.staleMs ?? DEFAULT_LOCK_STALE_MS) || DEFAULT_LOCK_STALE_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const payload = {
    token,
    pid: process.pid,
    createdAt: new Date().toISOString()
  };

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
    fs.closeSync(fd);
    return {
      acquired: true,
      lockPath,
      release() {
        const current = readJsonSafe(lockPath, {});
        if (current.token === token) {
          fs.rmSync(lockPath, { force: true });
        }
      }
    };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > staleMs) {
      fs.rmSync(lockPath, { force: true });
      return acquireFileLock(lockPath, options);
    }
    return {
      acquired: false,
      lockPath,
      ageMs
    };
  }
}

function runJsGraphQuery(graphPath, request) {
  const graph = normalizeGraphData(readJsonIfExists(graphPath) ?? {});
  if (request.action === "explain") {
    const node = findBestNode(graph, request.query);
    if (!node) {
      return { ok: false, error: "No matching graph node found." };
    }
    const neighbors = adjacency(graph.edges).get(node.id)?.slice(0, 20).map(({ node: id, edge }) => ({
      id,
      label: graph.nodeMap.get(id)?.label ?? id,
      relation: edge.relation,
      source_file: graph.nodeMap.get(id)?.source_file ?? ""
    })) ?? [];
    return { ok: true, action: "explain", node, neighbors };
  }

  if (request.action === "path") {
    const source = findBestNode(graph, request.source);
    const target = findBestNode(graph, request.target);
    if (!source || !target) {
      return { ok: false, error: "Source or target node was not found." };
    }
    const adj = adjacency(graph.edges);
    const queue = [{ id: source.id, path: [] }];
    const seen = new Set([source.id]);
    while (queue.length) {
      const current = queue.shift();
      if (current.id === target.id) {
        return { ok: true, action: "path", path: current.path };
      }
      for (const next of adj.get(current.id) ?? []) {
        if (seen.has(next.node)) {
          continue;
        }
        seen.add(next.node);
        const left = graph.nodeMap.get(current.id);
        const right = graph.nodeMap.get(next.node);
        queue.push({
          id: next.node,
          path: [
            ...current.path,
            {
              source: current.id,
              source_label: left?.label ?? current.id,
              target: next.node,
              target_label: right?.label ?? next.node,
              relation: next.edge.relation
            }
          ]
        });
      }
    }
    return { ok: false, error: "No graph path found." };
  }

  const terms = queryTerms(request.query);
  const seeds = rankGraphNodes(graph, request.query)
    .slice(0, 3)
    .map((entry) => entry.node);
  if (seeds.length === 0) {
    return { ok: false, error: "No matching graph region found." };
  }
  const adj = adjacency(graph.edges);
  const depth = Math.max(1, Number(request.depth ?? DEFAULT_QUERY_DEPTH) || DEFAULT_QUERY_DEPTH);
  const seen = new Set(seeds.map((node) => node.id));
  let frontier = seeds.map((node) => ({ id: node.id, depth: 0 }));
  while (frontier.length) {
    const current = frontier.shift();
    if (current.depth >= depth) {
      continue;
    }
    for (const next of adj.get(current.id) ?? []) {
      if (!seen.has(next.node)) {
        seen.add(next.node);
        frontier.push({ id: next.node, depth: current.depth + 1 });
      }
    }
  }
  const rankedEdges = rankGraphEdges(graph, seen, terms);
  const lines = [
    `Graph context for: ${request.query}`,
    "",
    "Nodes:",
    ...[...seen].slice(0, 80).map((id) => {
      const node = graph.nodeMap.get(id);
      return `- ${node?.label ?? id} [${id}]${node?.source_file ? ` (${node.source_file})` : ""}`;
    }),
    "",
    "Edges:",
    ...rankedEdges.slice(0, 120).map((edge) => {
      const source = graph.nodeMap.get(edge.source);
      const target = graph.nodeMap.get(edge.target);
      return `- ${source?.label ?? edge.source} --${edge.relation}--> ${target?.label ?? edge.target}`;
    })
  ];
  return {
    ok: true,
    action: "query",
    text: truncateText(lines.join("\n"), request.tokenBudget)
  };
}

export class ContextGraphProvider {
  constructor({ cwd, config = {} } = {}) {
    this.cwd = cwd ?? process.cwd();
    this.config = config;
  }

  get id() {
    return "context";
  }

  async getStatus() {
    return {
      enabled: false,
      provider: this.config.contextGraph?.provider ?? "graphify",
      available: false,
      graphPath: null,
      reportPath: null,
      nodeCount: 0,
      edgeCount: 0,
      lastUpdated: null,
      detail: "No context graph provider configured."
    };
  }

  async updateFiles() {
    return {
      ok: false,
      skipped: true,
      detail: "No context graph provider configured."
    };
  }

  async enqueueUpdate() {
    return {
      ok: false,
      skipped: true,
      detail: "No context graph provider configured."
    };
  }

  async queryGraph() {
    throw new Error(`${this.id} does not implement queryGraph().`);
  }

  async explainNode() {
    throw new Error(`${this.id} does not implement explainNode().`);
  }

  async shortestPath() {
    throw new Error(`${this.id} does not implement shortestPath().`);
  }

  async saveExecutionMemory() {
    return {
      ok: false,
      skipped: true,
      detail: "No context graph provider configured."
    };
  }

  async searchExecutionMemory() {
    return {
      ok: false,
      skipped: true,
      entries: [],
      detail: "No context graph provider configured."
    };
  }

  async getTaskContext() {
    return {
      ok: false,
      text: "",
      detail: "No context graph provider configured."
    };
  }

  async bootstrap() {
    return {
      ok: false,
      skipped: true,
      detail: "No context graph provider configured."
    };
  }
}

export class GraphifyContextProvider extends ContextGraphProvider {
  get id() {
    return "graphify";
  }

  get graphPath() {
    return graphPathFromConfig(this.cwd, this.config);
  }

  get reportPath() {
    return reportPathFromGraphPath(this.graphPath);
  }

  get memoryDir() {
    return path.join(path.dirname(this.graphPath), "memory", "orchestration");
  }

  get lockPath() {
    return path.join(path.dirname(this.graphPath), ".codex-graph-update.lock");
  }

  get pendingUpdatesPath() {
    return path.join(path.dirname(this.graphPath), "pending-updates.json");
  }

  get command() {
    return configuredGraphifyCommand(this.config);
  }

  get env() {
    return {
      ...process.env,
      PYTHONPATH: [
        path.join(this.cwd, "graphify-7"),
        process.env.PYTHONPATH
      ].filter(Boolean).join(path.delimiter),
      GRAPHIFY_OUT: path.dirname(this.graphPath)
    };
  }

  async getStatus() {
    const memoryDir = this.memoryDir;
    const memoryCount = fs.existsSync(memoryDir)
      ? fs.readdirSync(memoryDir).filter((name) => name.endsWith(".md")).length
      : 0;
    const graphExists = fs.existsSync(this.graphPath);
    const reportExists = fs.existsSync(this.reportPath);
    const cli = runCommand(this.command, [...configuredGraphifyArgs(this.config), "--help"], {
      cwd: this.cwd,
      env: this.env,
      maxBuffer: 1024 * 1024
    });
    const available = !cli.error && cli.status === 0;
    const data = graphExists ? readJsonIfExists(this.graphPath) : null;
    const nodes = Array.isArray(data?.nodes) ? data.nodes.length : 0;
    const links = Array.isArray(data?.links) ? data.links.length : Array.isArray(data?.edges) ? data.edges.length : 0;
    const stat = graphExists ? fs.statSync(this.graphPath) : null;

    return {
      enabled: isEnabled(this.config),
      provider: this.id,
      available,
      graphExists,
      reportExists,
      graphPath: this.graphPath,
      reportPath: this.reportPath,
      nodeCount: nodes,
      edgeCount: links,
      memoryDir,
      memoryCount,
      promptInjection: this.config.contextGraph?.injectIntoPrompts !== false,
      memoryRetrieval: this.config.contextGraph?.memoryRetrieval !== false,
      lastUpdated: stat?.mtime?.toISOString() ?? null,
      updateStrategy: this.config.contextGraph?.updateStrategy ?? "workflow-end",
      detail: available ? "graphify available" : cli.error?.message ?? cli.stderr.trim() ?? cli.stdout.trim() ?? "graphify unavailable"
    };
  }

  async checkRuntime() {
    const python = this.config.contextGraph?.pythonCommand ?? "python3";
    const result = runCommand(python, ["-c", buildPythonRuntimeCheckScript()], {
      cwd: this.cwd,
      env: this.env,
      maxBuffer: 1024 * 1024
    });
    if (result.error) {
      return {
        ok: false,
        command: python,
        error: result.error.message,
        checks: {}
      };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        command: python,
        error: result.stderr.trim() || result.stdout.trim() || `python exited ${result.status}`,
        checks: {}
      };
    }
    return {
      command: python,
      ...parsePythonJson(result)
    };
  }

  async bootstrap(options = {}) {
    const before = await this.getStatus();
    const runtime = await this.checkRuntime();
    const shouldBuild = options.force === true || !before.graphExists;
    let build = {
      ok: true,
      skipped: true,
      detail: before.graphExists ? "Context graph already exists. Use --force to rebuild." : "Build skipped."
    };

    if (!runtime.ok) {
      if (before.graphExists && !options.force) {
        return {
          ok: true,
          partial: true,
          runtime,
          before,
          build: {
            ok: true,
            skipped: true,
            detail: "Existing graph is usable for JS fallback retrieval; Python Graphify dependencies are needed for rebuilds."
          },
          after: before,
          configEnabled: options.configEnabled ?? isEnabled(this.config),
          nextSteps: [
            "Install Graphify Python dependencies before running graph rebuilds or live updates.",
            "Set `contextGraph.enabled` to `true` in `codex-companion.config.json` if prompt injection is not enabled yet."
          ],
          detail: "Context graph is usable, but Graphify rebuild dependencies are incomplete."
        };
      }
      return {
        ok: false,
        runtime,
        before,
        build: {
          ok: false,
          skipped: true,
          detail: "Graphify runtime dependencies are missing."
        },
        after: before,
        configEnabled: isEnabled(this.config),
        nextSteps: [
          "Install Graphify Python dependencies for this environment.",
          "Then rerun `/codex:graph init`."
        ],
        detail: "Context graph bootstrap could not start because runtime checks failed."
      };
    }

    if (shouldBuild) {
      build = await this.updateFiles(["."], {
        fullWorkspace: true,
        force: options.force === true,
        reason: "bootstrap"
      });
    }

    const after = await this.getStatus();
    const configEnabled = options.configEnabled ?? isEnabled(this.config);
    const ok = Boolean(runtime.ok && (build.ok || build.skipped) && after.graphExists);
    const nextSteps = [];
    if (!after.graphExists) {
      nextSteps.push("Review the graph build output, then rerun `/codex:graph init --force`.");
    }
    if (!configEnabled) {
      nextSteps.push("Set `contextGraph.enabled` to `true` in `codex-companion.config.json` to enable prompt injection and memory retrieval.");
    }
    if (after.graphExists && configEnabled) {
      nextSteps.push("Use `/codex:graph context <task>` to verify retrieval.");
    }

    return {
      ok,
      runtime,
      before,
      build,
      after,
      configEnabled,
      nextSteps,
      detail: ok ? "Context graph is ready." : "Context graph bootstrap completed with issues."
    };
  }

  async updateFiles(files = [], options = {}) {
    if (!isEnabled(this.config)) {
      return {
        ok: false,
        skipped: true,
        detail: "Context graph is disabled."
      };
    }
    const requestedFullWorkspace = options.fullWorkspace === true || files.some((filePath) => String(filePath) === ".");
    let changedFiles = requestedFullWorkspace ? ["."] : normalizeChangedFiles(this.cwd, files);
    if (changedFiles.length === 0 && !requestedFullWorkspace) {
      return {
        ok: true,
        skipped: true,
        changedFiles,
        detail: "No changed files were reported."
      };
    }

    const lockUpdates = this.config.contextGraph?.lockUpdates !== false;
    let lock = null;
    if (lockUpdates) {
      lock = acquireFileLock(this.lockPath, {
        staleMs: this.config.contextGraph?.staleLockMs ?? DEFAULT_LOCK_STALE_MS
      });
      if (!lock.acquired) {
        this.#recordPendingUpdate(changedFiles, options.reason ?? "workflow");
        return {
          ok: false,
          skipped: true,
          lockBusy: true,
          pending: true,
          changedFiles,
          lockPath: this.lockPath,
          detail: "Context graph update is already running; recorded changed files for the next sync."
        };
      }
    }

    const pending = this.#drainPendingUpdates();
    changedFiles = unique([...changedFiles, ...pending.files]);
    const timeoutMs = Number(this.config.contextGraph?.updateTimeoutMs ?? 120000) || 120000;
    const args = [...configuredGraphifyArgs(this.config), "update", this.cwd];
    if (options.force) {
      args.push("--force");
    }
    try {
      const result = runCommand(this.command, args, {
        cwd: this.cwd,
        env: this.env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs
      });
      const ok = !result.error && result.status === 0;
      if (!ok) {
        this.#recordPendingUpdate(changedFiles, options.reason ?? "failed-update");
      }
      return {
        ok,
        skipped: false,
        changedFiles,
        pendingFilesApplied: pending.files,
        command: `${this.command} ${args.join(" ")}`,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        detail: ok
          ? `Updated context graph for ${changedFiles.length} changed file(s).`
          : result.error?.message ?? result.stderr.trim() ?? result.stdout.trim() ?? `graphify exited ${result.status}`
      };
    } finally {
      lock?.release?.();
    }
  }

  async enqueueUpdate(files = [], options = {}) {
    if (!isEnabled(this.config)) {
      return {
        ok: false,
        skipped: true,
        detail: "Context graph is disabled."
      };
    }
    const requestedFullWorkspace = options.fullWorkspace === true || files.some((filePath) => String(filePath) === ".");
    const changedFiles = requestedFullWorkspace ? ["."] : normalizeChangedFiles(this.cwd, files);
    if (changedFiles.length === 0 && !requestedFullWorkspace) {
      return {
        ok: true,
        skipped: true,
        changedFiles,
        detail: "No changed files were reported."
      };
    }
    this.#recordPendingUpdate(changedFiles, options.reason ?? "background-sync");
    const scriptPath = options.workerScriptPath ?? process.argv[1];
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      return {
        ok: false,
        queued: true,
        workerStarted: false,
        changedFiles,
        detail: "Recorded pending graph update, but no companion worker script was available."
      };
    }
    const child = spawn(process.execPath, [scriptPath, "graph-sync-worker", "--cwd", this.cwd], {
      cwd: this.cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return {
      ok: true,
      queued: true,
      workerStarted: true,
      pid: child.pid ?? null,
      changedFiles,
      detail: `Queued background context graph sync for ${changedFiles.length} changed file(s).`
    };
  }

  async queryGraph(query, options = {}) {
    return this.#runGraphQuery({
      action: "query",
      query,
      tokenBudget: options.tokenBudget ?? this.config.contextGraph?.queryTokenBudget ?? DEFAULT_QUERY_TOKEN_BUDGET,
      depth: options.depth ?? this.config.contextGraph?.queryDepth ?? DEFAULT_QUERY_DEPTH
    });
  }

  async explainNode(query, options = {}) {
    return this.#runGraphQuery({
      action: "explain",
      query,
      tokenBudget: options.tokenBudget ?? this.config.contextGraph?.queryTokenBudget ?? DEFAULT_QUERY_TOKEN_BUDGET,
      depth: options.depth ?? this.config.contextGraph?.queryDepth ?? DEFAULT_QUERY_DEPTH
    });
  }

  async shortestPath(source, target, options = {}) {
    return this.#runGraphQuery({
      action: "path",
      source,
      target,
      tokenBudget: options.tokenBudget ?? this.config.contextGraph?.queryTokenBudget ?? DEFAULT_QUERY_TOKEN_BUDGET,
      depth: options.depth ?? this.config.contextGraph?.queryDepth ?? DEFAULT_QUERY_DEPTH
    });
  }

  async saveExecutionMemory(entry = {}) {
    if (!isEnabled(this.config) || this.config.contextGraph?.saveExecutionMemory === false) {
      return {
        ok: false,
        skipped: true,
        detail: "Execution memory is disabled."
      };
    }
    const memoryDir = this.memoryDir;
    fs.mkdirSync(memoryDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const workflow = String(entry.workflow ?? "workflow").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const filePath = path.join(memoryDir, `${timestamp}-${workflow}.md`);
    const files = unique(entry.filesModified ?? entry.touchedFiles ?? []);
    const commands = unique(entry.commandsExecuted ?? entry.shellCommands ?? []);
    const body = [
      "---",
      "type: orchestration-memory",
      `workflow: ${entry.workflow ?? "unknown"}`,
      `mode: ${entry.mode ?? "balanced"}`,
      `created_at: ${new Date().toISOString()}`,
      "---",
      "",
      "# Orchestration Memory",
      "",
      `Task: ${String(entry.task ?? "").trim() || "unknown"}`,
      "",
      `Summary: ${String(entry.summary ?? "Workflow completed.").trim()}`,
      "",
      "Files Modified:",
      ...(files.length ? files.map((file) => `- ${file}`) : ["- none"]),
      "",
      "Commands Executed:",
      ...(commands.length ? commands.map((command) => `- ${command}`) : ["- none"])
    ].join("\n");
    fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
    return {
      ok: true,
      skipped: false,
      filePath,
      detail: `Saved orchestration memory to ${filePath}.`
    };
  }

  async searchExecutionMemory(query, options = {}) {
    if (!isEnabled(this.config) || this.config.contextGraph?.memoryRetrieval === false) {
      return {
        ok: false,
        skipped: true,
        entries: [],
        detail: "Execution memory retrieval is disabled."
      };
    }
    if (!fs.existsSync(this.memoryDir)) {
      return {
        ok: true,
        skipped: true,
        entries: [],
        detail: "No orchestration memory directory exists yet."
      };
    }
    const terms = queryTerms(query);
    const limit = Math.max(0, Number(options.limit ?? this.config.contextGraph?.maxMemoryEntries ?? DEFAULT_MEMORY_LIMIT) || DEFAULT_MEMORY_LIMIT);
    const tokenBudget = options.tokenBudget ?? this.config.contextGraph?.memoryTokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET;
    const entries = fs.readdirSync(this.memoryDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        const filePath = path.join(this.memoryDir, name);
        const content = safeReadText(filePath);
        const stat = fs.statSync(filePath);
        return {
          filePath,
          name,
          content,
          body: stripFrontmatter(content),
          mtimeMs: stat.mtimeMs,
          score: scoreText(`${name}\n${content}`, terms) + recencyBoost(stat.mtimeMs)
        };
      })
      .filter((entry) => entry.score > 0 || terms.length === 0)
      .sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map((entry) => ({
        filePath: entry.filePath,
        name: entry.name,
        score: entry.score,
        text: truncateText(entry.body, Math.max(200, Math.floor(tokenBudget / Math.max(1, limit))))
      }));

    return {
      ok: true,
      skipped: false,
      entries,
      detail: entries.length ? `Found ${entries.length} relevant memory entr${entries.length === 1 ? "y" : "ies"}.` : "No relevant execution memory found."
    };
  }

  async getTaskContext(query, options = {}) {
    const tokenBudget = options.tokenBudget ?? this.config.contextGraph?.queryTokenBudget ?? DEFAULT_QUERY_TOKEN_BUDGET;
    const graphBudget = Math.max(300, Math.floor(tokenBudget * 0.65));
    const memoryBudget = Math.max(200, tokenBudget - graphBudget);
    const graph = fs.existsSync(this.graphPath)
      ? await this.queryGraph(query, {
          tokenBudget: graphBudget,
          depth: options.depth
        })
      : { ok: false, error: `Graph not found: ${this.graphPath}` };
    const memory = await this.searchExecutionMemory(query, {
      tokenBudget: memoryBudget,
      limit: options.memoryLimit
    });

    const sections = [];
    if (graph.ok && graph.text) {
      sections.push("## Graph Context", graph.text.trim());
    }
    if (memory.ok && memory.entries.length) {
      sections.push(
        "## Execution Memory",
        memory.entries
          .map((entry) => [`### ${entry.name}`, entry.text].join("\n"))
          .join("\n\n")
      );
    }

    if (sections.length === 0) {
      return {
        ok: false,
        graph,
        memory,
        text: "",
        detail: graph.error ?? memory.detail ?? "No task context found."
      };
    }

    return {
      ok: true,
      graph,
      memory,
      text: truncateText(sections.join("\n\n"), tokenBudget),
      detail: "Retrieved graph context and execution memory."
    };
  }

  #recordPendingUpdate(files = [], reason = "workflow") {
    if (this.config.contextGraph?.recordPendingUpdates === false) {
      return;
    }
    const existing = readJsonSafe(this.pendingUpdatesPath, {
      version: 1,
      files: [],
      events: []
    });
    const next = {
      version: 1,
      updatedAt: new Date().toISOString(),
      files: unique([...(existing.files ?? []), ...files]),
      events: [
        ...(existing.events ?? []),
        {
          reason,
          files,
          createdAt: new Date().toISOString()
        }
      ].slice(-50)
    };
    writeJsonAtomic(this.pendingUpdatesPath, next);
  }

  #drainPendingUpdates() {
    const existing = readJsonSafe(this.pendingUpdatesPath, {
      files: [],
      events: []
    });
    if (fs.existsSync(this.pendingUpdatesPath)) {
      fs.rmSync(this.pendingUpdatesPath, { force: true });
    }
    return {
      files: unique(existing.files ?? []),
      events: existing.events ?? []
    };
  }

  #runGraphQuery(request) {
    if (!fs.existsSync(this.graphPath)) {
      return {
        ok: false,
        error: `Graph not found: ${this.graphPath}`
      };
    }
    const jsResult = runJsGraphQuery(this.graphPath, request);
    if (jsResult.ok || !this.config.contextGraph?.preferPythonQueries) {
      return jsResult;
    }
    const script = buildPythonGraphQueryScript({
      graphPath: this.graphPath,
      ...request
    });
    const python = this.config.contextGraph?.pythonCommand ?? "python3";
    const result = runCommand(python, ["-c", script], {
      cwd: this.cwd,
      env: this.env,
      maxBuffer: 10 * 1024 * 1024
    });
    if (result.error) {
      return {
        ok: false,
        error: result.error.message
      };
    }
    return parsePythonJson(result);
  }
}

export function createContextGraphProvider({ cwd, config = {} } = {}) {
  const graphConfig = config.contextGraph ?? {};
  if (graphConfig.enabled !== true) {
    return new ContextGraphProvider({ cwd, config });
  }
  const provider = graphConfig.provider ?? "graphify";
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported context graph provider "${provider}".`);
  }
  return new GraphifyContextProvider({ cwd, config });
}

export function detectParallelWriteConflicts(outputs = []) {
  const ownersByFile = new Map();
  for (const output of outputs ?? []) {
    const owner = output.label ?? output.providerId ?? "agent";
    for (const filePath of unique(output.touchedFiles ?? [])) {
      const normalized = String(filePath);
      if (!ownersByFile.has(normalized)) {
        ownersByFile.set(normalized, []);
      }
      ownersByFile.get(normalized).push(owner);
    }
  }
  return [...ownersByFile.entries()]
    .filter(([, owners]) => new Set(owners).size > 1)
    .map(([filePath, owners]) => ({
      filePath,
      owners: [...new Set(owners)]
    }));
}

export async function updateContextGraphAfterWorkflow({ cwd, config, workflowResult, onProgress } = {}) {
  const provider = createContextGraphProvider({ cwd, config });
  if (!isEnabled(config)) {
    return null;
  }
  const files = workflowResult?.metrics?.filesModified ?? workflowResult?.codex?.touchedFiles ?? [];
  const conflicts = workflowResult?.workflow === "parallel"
    ? detectParallelWriteConflicts(workflowResult.outputs ?? [])
    : [];
  onProgress?.({ message: "[GRAPH] Updating context graph.", phase: "graph" });
  const backgroundSync = config?.contextGraph?.backgroundSync !== false;
  const update = backgroundSync
    ? await provider.enqueueUpdate(files, {
        reason: workflowResult?.workflow ?? "workflow"
      })
    : await provider.updateFiles(files, {
        reason: workflowResult?.workflow ?? "workflow"
      });
  if (update.ok) {
    onProgress?.({ message: `[GRAPH] ${update.detail}`, phase: "graph" });
  } else if (!update.skipped) {
    onProgress?.({ message: `[GRAPH] ${update.detail}`, phase: "graph" });
  }
  const memory = await provider.saveExecutionMemory({
    workflow: workflowResult?.workflow,
    mode: workflowResult?.mode,
    task: workflowResult?.task,
    summary: workflowResult?.summary,
    filesModified: workflowResult?.metrics?.filesModified ?? [],
    shellCommands: workflowResult?.metrics?.shellCommands ?? []
  });
  return {
    update,
    memory,
    conflicts
  };
}

export async function retrieveContextGraphForTask({ cwd, config, task, workflow, mode, onProgress } = {}) {
  const graphConfig = config?.contextGraph ?? {};
  if (graphConfig.enabled !== true || graphConfig.injectIntoPrompts === false) {
    return {
      enabled: graphConfig.enabled === true,
      injected: false,
      text: "",
      detail: graphConfig.enabled === true ? "Prompt injection is disabled." : "Context graph is disabled."
    };
  }

  const provider = createContextGraphProvider({ cwd, config });
  const status = await provider.getStatus();
  if (!status.graphExists) {
    return {
      enabled: true,
      injected: false,
      text: "",
      status,
      detail: "Context graph has not been built yet."
    };
  }

  const tokenBudgetByMode = graphConfig.tokenBudgetByMode ?? {};
  const tokenBudget =
    tokenBudgetByMode[mode] ??
    graphConfig.promptTokenBudget ??
    graphConfig.queryTokenBudget ??
    DEFAULT_QUERY_TOKEN_BUDGET;
  const query = [
    workflow ? `workflow:${workflow}` : "",
    String(task ?? "").trim()
  ].filter(Boolean).join(" ");

  onProgress?.({ message: "[GRAPH] Retrieving task context.", phase: "graph" });
  const result = await provider.getTaskContext(query, {
    tokenBudget,
    depth: graphConfig.promptQueryDepth ?? graphConfig.queryDepth ?? DEFAULT_QUERY_DEPTH
  });
  if (!result.ok) {
    return {
      enabled: true,
      injected: false,
      text: "",
      status,
      error: result.error,
      detail: result.error ?? "No relevant graph context found."
    };
  }

  return {
    enabled: true,
    injected: true,
    text: result.text ?? "",
    status,
    tokenBudget,
    detail: "Injected task-scoped graph context."
  };
}

export function summarizeContextGraphConfig(config = {}) {
  const graphConfig = isNonEmptyObject(config.contextGraph) ? config.contextGraph : {};
  return {
    enabled: graphConfig.enabled === true,
    provider: graphConfig.provider ?? "graphify",
    graphPath: graphConfig.graphPath ?? path.join(DEFAULT_GRAPHIFY_OUT, "graph.json"),
    outputDir: graphConfig.outputDir ?? DEFAULT_GRAPHIFY_OUT,
    updateStrategy: graphConfig.updateStrategy ?? "workflow-end",
    backgroundSync: graphConfig.backgroundSync !== false,
    lockUpdates: graphConfig.lockUpdates !== false,
    staleLockMs: graphConfig.staleLockMs ?? DEFAULT_LOCK_STALE_MS,
    recordPendingUpdates: graphConfig.recordPendingUpdates !== false,
    queryTokenBudget: graphConfig.queryTokenBudget ?? DEFAULT_QUERY_TOKEN_BUDGET,
    queryDepth: graphConfig.queryDepth ?? DEFAULT_QUERY_DEPTH,
    injectIntoPrompts: graphConfig.injectIntoPrompts !== false,
    promptTokenBudget: graphConfig.promptTokenBudget ?? graphConfig.queryTokenBudget ?? DEFAULT_QUERY_TOKEN_BUDGET,
    memoryRetrieval: graphConfig.memoryRetrieval !== false,
    maxMemoryEntries: graphConfig.maxMemoryEntries ?? DEFAULT_MEMORY_LIMIT,
    memoryTokenBudget: graphConfig.memoryTokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET,
    saveExecutionMemory: graphConfig.saveExecutionMemory !== false
  };
}
