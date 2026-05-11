import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createLoopGuard } from "../plugins/codex/scripts/lib/orchestration/loop-protection.mjs";
import { createMetricsCollector, renderExecutionMetrics } from "../plugins/codex/scripts/lib/orchestration/metrics.mjs";
import { normalizeWorkflowMode, resolveWorkflowMode } from "../plugins/codex/scripts/lib/orchestration/modes.mjs";
import { buildCodexInlinePrompt } from "../plugins/codex/scripts/lib/orchestration/prompts.mjs";
import { sanitizeCommandPrompt } from "../plugins/codex/scripts/lib/orchestration/sanitizer.mjs";
import {
  buildRecommendedContextGraphConfig,
  createContextGraphProvider,
  detectParallelWriteConflicts,
  GraphifyContextProvider,
  retrieveContextGraphForTask,
  runContextGraphStressTest,
  summarizeContextGraphConfig
} from "../plugins/codex/scripts/lib/orchestration/context-graph.mjs";
import { makeTempDir } from "./helpers.mjs";

test("sanitizer strips duplicated slash-command prefixes while preserving prompt content", () => {
  assert.equal(
    sanitizeCommandPrompt("/codex:codex-inline /codex:codex-inline create server").text,
    "create server"
  );
  assert.equal(
    sanitizeCommandPrompt("  codex-inline   pair   add route\nand tests").text,
    "add route\nand tests"
  );
  assert.equal(
    sanitizeCommandPrompt("\"/codex:codex-inline\" should remain quoted").text,
    "\"/codex:codex-inline\" should remain quoted"
  );
});

test("metrics collector estimates usage and renders execution metrics", () => {
  const metrics = createMetricsCollector({ mode: { current: "fast" } });
  metrics.startExecution({ workflow: "pair", mode: "fast" });
  metrics.trackModelUsage("claude", { inputText: "plan input", outputText: "plan output" });
  metrics.trackModelUsage("codex", { inputTokens: 100, outputTokens: 50 });
  metrics.trackGraphContext({
    injected: true,
    mode: "fast",
    trace: {
      durationMs: 23,
      confidence: "HIGH",
      nodeCount: 18,
      edgeCount: 24
    },
    analytics: {
      confidence: "HIGH",
      nodeCount: 18,
      edgeCount: 24,
      estimatedTokens: 420,
      rawEstimatedTokens: 1800,
      estimatedTokenSavings: 1380,
      compressionPercent: 77,
      graphHitRate: 80,
      usefulnessScore: 86
    }
  });
  metrics.trackShellCommand("npm test");
  metrics.trackFileChange("README.md");
  const finalMetrics = metrics.finishExecution();
  const rendered = renderExecutionMetrics(finalMetrics);

  assert.equal(finalMetrics.workflow, "pair");
  assert.equal(finalMetrics.mode, "fast");
  assert.equal(finalMetrics.commandsExecutedCount, 1);
  assert.equal(finalMetrics.filesModifiedCount, 1);
  assert.match(rendered, /\[SYSTEM\] Execution Metrics/);
  assert.match(rendered, /Workflow:\n- pair/);
  assert.match(rendered, /Mode:\n- FAST/);
  assert.match(rendered, /\[SYSTEM\] Graph Context Metrics/);
  assert.match(rendered, /Retrieved Nodes:\n- 18/);
  assert.match(rendered, /Estimated Token Savings:\n- 1380/);
  assert.match(rendered, /Retrieval Confidence:\n- HIGH/);
  assert.match(rendered, /\[SYSTEM\] Execution Timeline/);
  assert.match(rendered, /graph-context-retrieval/);
});

test("workflow modes normalize and reject unsupported values", () => {
  assert.equal(normalizeWorkflowMode("architect"), "architect");
  assert.equal(resolveWorkflowMode({ mode: { current: "fast" } }).label, "FAST");
  assert.throws(() => normalizeWorkflowMode("turbo"), /Unsupported workflow mode/);
});

test("loop guard blocks repeated prompts and excessive depth", () => {
  const guard = createLoopGuard({ loopProtection: { repeatedPromptLimit: 1 } });
  guard.trackPrompt("same prompt");
  assert.throws(() => guard.trackPrompt("same   prompt"), /Repeated execution prompt detected/);

  const deepGuard = createLoopGuard({ loopProtection: { maxDepth: 1 } }, { depth: 2 });
  assert.throws(() => deepGuard.assertCanStart("pair"), /Maximum orchestration depth exceeded/);
});

test("context graph config summarizes safe Graphify defaults", () => {
  const summary = summarizeContextGraphConfig({
    contextGraph: {
      enabled: true,
      graphPath: "custom/graph.json"
    }
  });

  assert.equal(summary.enabled, true);
  assert.equal(summary.provider, "graphify");
  assert.equal(summary.graphPath, "custom/graph.json");
  assert.equal(summary.updateStrategy, "workflow-end");
  assert.equal(summary.backgroundSync, true);
  assert.equal(summary.lockUpdates, true);
  assert.equal(summary.recordPendingUpdates, true);
  assert.equal(summary.injectIntoPrompts, true);
  assert.equal(summary.memoryRetrieval, true);
  assert.equal(summary.maxMemoryEntries, 3);
  assert.equal(summary.saveExecutionMemory, true);
});

test("recommended context graph config is enabled and conservative", () => {
  const config = buildRecommendedContextGraphConfig();

  assert.equal(config.enabled, true);
  assert.equal(config.provider, "graphify");
  assert.equal(config.graphPath, "graphify-out/graph.json");
  assert.equal(config.backgroundSync, true);
  assert.equal(config.lockUpdates, true);
  assert.equal(config.recordPendingUpdates, true);
  assert.equal(config.injectIntoPrompts, true);
  assert.equal(config.memoryRetrieval, true);
  assert.equal(config.saveExecutionMemory, true);
});

test("context graph provider stays disabled unless explicitly enabled", async () => {
  const provider = createContextGraphProvider({
    cwd: process.cwd(),
    config: {}
  });
  const status = await provider.getStatus();
  const update = await provider.updateFiles(["README.md"]);

  assert.equal(status.enabled, false);
  assert.equal(status.available, false);
  assert.equal(update.skipped, true);
});

test("Graphify provider resolves workspace graph paths", async () => {
  const cwd = process.cwd();
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-out/graph.json"
      }
    }
  });
  const status = await provider.getStatus();

  assert.equal(status.provider, "graphify");
  assert.equal(status.graphPath, `${cwd}/graphify-out/graph.json`);
  assert.equal(status.reportPath, `${cwd}/graphify-out/GRAPH_REPORT.md`);
  assert.equal(status.memoryDir, `${cwd}/graphify-out/memory/orchestration`);
  assert.equal(status.promptInjection, true);
  assert.equal(status.memoryRetrieval, true);
  assert.equal(status.workspace.outputDirExists, false);
  assert.equal(status.lockStatus, "clear");
});

test("Graphify provider status survives invalid graph json", async () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "graphify-out", "graph.json"), "{bad json", "utf8");
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-out/graph.json"
      }
    }
  });

  const status = await provider.getStatus();

  assert.equal(status.graphExists, true);
  assert.equal(status.graphValid, false);
  assert.match(status.graphError, /JSON|Unexpected|Expected/i);
});

test("Graphify provider can query graph json without Python graph dependencies", async () => {
  const cwd = process.cwd();
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-7/worked/httpx/graph.json"
      }
    }
  });
  const result = await provider.queryGraph("auth client", { tokenBudget: 500 });

  assert.equal(result.ok, true);
  assert.match(result.text, /Graph context for: auth client/);
  assert.match(result.text, /Retrieval confidence:/);
  assert.match(result.text, /score:/);
  assert.match(result.text, /Auth|Client/);
  assert.ok(result.retrieval.nodeCount <= 32);
  assert.ok(result.retrieval.rawEstimatedTokens >= result.retrieval.estimatedTokens);
  assert.ok(result.retrieval.estimatedTokenSavings >= 0);
  assert.ok(result.retrieval.usefulnessScore > 0);
  assert.ok(result.retrieval.graphHitRate > 0);
  assert.equal(result.trace.phase, "graph-query");
  assert.ok(result.trace.durationMs >= 0);
});

test("Graphify JS retrieval ranks file path matches into compact context", async () => {
  const provider = new GraphifyContextProvider({
    cwd: process.cwd(),
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-7/worked/httpx/graph.json"
      }
    }
  });
  const result = await provider.queryGraph('"auth.py" retry client', { tokenBudget: 500 });

  assert.equal(result.ok, true);
  assert.match(result.text, /auth\.py/);
  assert.match(result.text, /client\.py|Client/);
  assert.match(result.text, /reasons:/);
});

test("Graphify JS retrieval honors configured node and edge limits", async () => {
  const provider = new GraphifyContextProvider({
    cwd: process.cwd(),
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-7/worked/httpx/graph.json",
        retrievalNodeLimit: 8,
        retrievalEdgeLimit: 10
      }
    }
  });
  const result = await provider.queryGraph("auth client retry transport", { tokenBudget: 800 });

  assert.equal(result.ok, true);
  assert.ok(result.retrieval.nodeCount <= 8);
  assert.ok(result.retrieval.edgeCount <= 10);
  assert.match(result.text, /Retrieved nodes:/);
});

test("Graphify JS retrieval compresses context within small budgets", async () => {
  const provider = new GraphifyContextProvider({
    cwd: process.cwd(),
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-7/worked/httpx/graph.json",
        retrievalLimitsByMode: {
          fast: {
            seedLimit: 4,
            nodeLimit: 18,
            edgeLimit: 24,
            detailNodeLimit: 4,
            detailEdgeLimit: 6,
            compressionMode: "high"
          }
        }
      }
    }
  });
  const result = await provider.queryGraph("auth client retry transport headers cookies", {
    mode: "fast",
    tokenBudget: 360
  });

  assert.equal(result.ok, true);
  assert.equal(result.retrieval.mode, "fast");
  assert.equal(result.retrieval.compressionMode, "high");
  assert.match(result.text, /Context budget: 360 tokens/);
  assert.match(result.text, /Compressed supporting nodes:|Priority nodes:/);
  assert.ok(result.retrieval.estimatedTokens <= 420);
  assert.ok(result.retrieval.compressionPercent >= 0);
  assert.ok(result.retrieval.estimatedTokenSavings >= 0);
  assert.ok(result.retrieval.detailNodeCount <= result.retrieval.nodeCount);
});

test("context graph retrieval applies mode-aware budgets and depth", async () => {
  const config = {
    contextGraph: {
      enabled: true,
      graphPath: "graphify-7/worked/httpx/graph.json",
      tokenBudgetByMode: {
        fast: 700,
        architect: 2200
      },
      queryDepthByMode: {
        fast: 1,
        architect: 3
      },
      retrievalLimitsByMode: {
        fast: {
          seedLimit: 3,
          nodeLimit: 10,
          edgeLimit: 12,
          detailNodeLimit: 4,
          detailEdgeLimit: 6,
          compressionMode: "high"
        },
        architect: {
          seedLimit: 8,
          nodeLimit: 60,
          edgeLimit: 90,
          detailNodeLimit: 20,
          detailEdgeLimit: 40,
          compressionMode: "light"
        }
      }
    }
  };
  const fast = await retrieveContextGraphForTask({
    cwd: process.cwd(),
    config,
    task: "change auth client retry transport",
    workflow: "codex-inline",
    mode: "fast"
  });
  const architect = await retrieveContextGraphForTask({
    cwd: process.cwd(),
    config,
    task: "change auth client retry transport",
    workflow: "pair",
    mode: "architect"
  });

  assert.equal(fast.injected, true);
  assert.equal(architect.injected, true);
  assert.equal(fast.mode, "fast");
  assert.equal(architect.mode, "architect");
  assert.equal(fast.budget.tokenBudget, 700);
  assert.equal(architect.budget.tokenBudget, 2200);
  assert.ok(fast.analytics.usefulnessScore > 0);
  assert.ok(architect.analytics.estimatedTokenSavings >= 0);
  assert.equal(fast.trace.phase, "prompt-context-retrieval");
  assert.ok(fast.trace.durationMs >= 0);
  assert.ok(architect.budget.graphBudget > fast.budget.graphBudget);
  assert.match(fast.text, /Workflow mode: FAST/);
  assert.match(architect.text, /Workflow mode: ARCHITECT/);
});

test("context graph stress test reports bounded retrieval stability", async () => {
  const result = await runContextGraphStressTest({
    cwd: process.cwd(),
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-7/worked/httpx/graph.json"
      }
    },
    queries: ["auth client", "transport retry"],
    iterations: 4,
    tokenBudget: 700,
    mode: "fast"
  });

  assert.equal(result.mode, "fast");
  assert.equal(result.iterations, 4);
  assert.equal(result.failures, 0);
  assert.equal(result.tokenBudgetOverruns, 0);
  assert.equal(result.runs.length, 4);
  assert.ok(result.p95Ms >= 0);
});


test("context graph retrieval is token-bounded and prompt-ready", async () => {
  const context = await retrieveContextGraphForTask({
    cwd: process.cwd(),
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-7/worked/httpx/graph.json",
        promptTokenBudget: 500
      }
    },
    task: "change auth client",
    workflow: "codex-inline",
    mode: "fast"
  });

  assert.equal(context.injected, true);
  assert.match(context.text, /Graph context for:/);
  assert.match(context.text, /Retrieval confidence:/);

  const prompt = buildCodexInlinePrompt({
    task: "change auth client",
    contextGraphText: context.text
  });
  assert.match(prompt, /Relevant context graph:/);
  assert.match(prompt, /Verify against source files/);
});

test("Graphify provider saves and retrieves orchestration memory", async () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, "graphify-out"), { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "graphify-7", "worked", "httpx", "graph.json"),
    path.join(cwd, "graphify-out", "graph.json")
  );
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-out/graph.json",
        maxMemoryEntries: 2
      }
    }
  });

  const saved = await provider.saveExecutionMemory({
    workflow: "pair",
    mode: "balanced",
    task: "fix auth client retries",
    summary: "Updated auth client retry behavior.",
    filesModified: ["src/auth/client.ts"],
    shellCommands: ["npm test"]
  });
  const memory = await provider.searchExecutionMemory("auth retries", { tokenBudget: 400 });
  const context = await provider.getTaskContext("auth retries", { tokenBudget: 900 });

  assert.equal(saved.ok, true);
  assert.equal(memory.ok, true);
  assert.equal(memory.entries.length, 1);
  assert.match(memory.entries[0].text, /fix auth client retries/);
  assert.equal(context.ok, true);
  assert.match(context.text, /## Graph Context/);
  assert.match(context.text, /## Execution Memory/);
});

test("Graphify provider records pending updates when graph lock is busy", async () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, "graphify-out"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "graphify-out", ".codex-graph-update.lock"),
    JSON.stringify({ token: "other-process", createdAt: new Date().toISOString() }),
    "utf8"
  );
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-out/graph.json",
        staleLockMs: 600000
      }
    }
  });

  const update = await provider.updateFiles(["src/app.ts"], { reason: "test" });
  const pending = JSON.parse(fs.readFileSync(path.join(cwd, "graphify-out", "pending-updates.json"), "utf8"));

  assert.equal(update.skipped, true);
  assert.equal(update.lockBusy, true);
  assert.deepEqual(pending.files, ["src/app.ts"]);
});

test("Graphify provider recovers workspace directories and stale locks", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, "graphify-out"), { recursive: true });
  const lockPath = path.join(cwd, "graphify-out", ".codex-graph-update.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ createdAt: "old" }), "utf8");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-out/graph.json",
        staleLockMs: 1000
      }
    }
  });

  const result = provider.recoverWorkspace();

  assert.equal(result.after.memoryExists, true);
  assert.equal(result.after.lockExists, false);
  assert.match(result.actions.join("\n"), /cleared stale graph update lock/);
});

test("Graphify provider can enqueue background updates without running Graphify inline", async () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, "graphify-out"), { recursive: true });
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-out/graph.json"
      }
    }
  });

  const update = await provider.enqueueUpdate(["src/bg.ts"], {
    reason: "test-background",
    workerScriptPath: path.join(cwd, "missing-worker.mjs")
  });
  const pending = JSON.parse(fs.readFileSync(path.join(cwd, "graphify-out", "pending-updates.json"), "utf8"));

  assert.equal(update.queued, true);
  assert.equal(update.workerStarted, false);
  assert.deepEqual(pending.files, ["src/bg.ts"]);
});


test("parallel write conflict detection reports files touched by multiple agents", () => {
  const conflicts = detectParallelWriteConflicts([
    { providerId: "codex", label: "Codex", touchedFiles: ["src/app.ts", "src/a.ts"] },
    { providerId: "codex-fast", label: "Codex Fast", touchedFiles: ["src/app.ts"] }
  ]);

  assert.deepEqual(conflicts, [
    {
      filePath: "src/app.ts",
      owners: ["Codex", "Codex Fast"]
    }
  ]);
});

test("Graphify provider re-queues changed files when update command fails", async () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, "graphify-out"), { recursive: true });
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-out/graph.json",
        command: process.execPath,
        commandArgs: ["-e", "process.exit(7)"]
      }
    }
  });

  const update = await provider.updateFiles(["src/fail.ts"], { reason: "test-failure" });
  const pending = JSON.parse(fs.readFileSync(path.join(cwd, "graphify-out", "pending-updates.json"), "utf8"));

  assert.equal(update.ok, false);
  assert.deepEqual(pending.files, ["src/fail.ts"]);
});

test("Graphify bootstrap reports ready when graph already exists", async () => {
  const cwd = process.cwd();
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-7/worked/httpx/graph.json"
      }
    }
  });

  const result = await provider.bootstrap();

  assert.equal(result.ok, true);
  assert.equal(result.build.skipped, true);
  assert.equal(result.after.graphExists, true);
});

test("Graphify bootstrap creates storage and reports graphifyy install command when runtime is missing", async () => {
  const cwd = makeTempDir();
  const provider = new GraphifyContextProvider({
    cwd,
    config: {
      contextGraph: {
        enabled: true,
        graphPath: "graphify-out/graph.json",
        pythonCommand: "missing-python-for-graphify-test"
      }
    }
  });

  const result = await provider.bootstrap();

  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(path.join(cwd, "graphify-out")), true);
  assert.equal(fs.existsSync(path.join(cwd, "graphify-out", "memory", "orchestration")), true);
  assert.equal(result.recovery.ok, true);
  assert.match(result.runtime.installCommand, /graphifyy/);
  assert.match(result.nextSteps.join("\n"), /graphifyy/);
});
