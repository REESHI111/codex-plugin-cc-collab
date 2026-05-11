function estimateTokens(text) {
  const value = String(text ?? "").trim();
  if (!value) {
    return 0;
  }
  return Math.max(1, Math.ceil(value.length / 4));
}

function uniqueCount(values) {
  return new Set((values ?? []).filter(Boolean)).size;
}

function estimateCost(metrics, config = {}) {
  const rates = {
    claudeInputPerMTok: 3,
    claudeOutputPerMTok: 15,
    codexInputPerMTok: 1.25,
    codexOutputPerMTok: 10,
    ...(config.metrics?.costRates ?? {})
  };
  const total =
    (metrics.claude.inputTokens / 1_000_000) * rates.claudeInputPerMTok +
    (metrics.claude.outputTokens / 1_000_000) * rates.claudeOutputPerMTok +
    (metrics.codex.inputTokens / 1_000_000) * rates.codexInputPerMTok +
    (metrics.codex.outputTokens / 1_000_000) * rates.codexOutputPerMTok;
  return Number(total.toFixed(4));
}

export function createMetricsCollector(config = {}) {
  const metrics = {
    workflow: "unknown",
    mode: config.mode?.current ?? config.mode?.default ?? "balanced",
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    claude: {
      inputTokens: 0,
      outputTokens: 0
    },
    codex: {
      inputTokens: 0,
      outputTokens: 0
    },
    graphContext: {
      retrievals: [],
      injectedCount: 0,
      skippedCount: 0,
      retrievedNodeCount: 0,
      retrievedEdgeCount: 0,
      estimatedTokens: 0,
      rawEstimatedTokens: 0,
      estimatedTokenSavings: 0,
      averageUsefulnessScore: 0,
      averageGraphHitRate: 0,
      highestConfidence: "NONE"
    },
    filesModified: [],
    shellCommands: [],
    estimatedCost: 0
  };

  return {
    startExecution({ workflow, mode } = {}) {
      metrics.workflow = workflow ?? metrics.workflow;
      metrics.mode = mode ?? metrics.mode;
      metrics.startedAt = Date.now();
      return metrics;
    },
    trackModelUsage(model, usage = {}) {
      const bucket = model === "claude" ? metrics.claude : metrics.codex;
      bucket.inputTokens += Number(usage.inputTokens ?? estimateTokens(usage.inputText)) || 0;
      bucket.outputTokens += Number(usage.outputTokens ?? estimateTokens(usage.outputText)) || 0;
    },
    trackShellCommand(command) {
      if (command) {
        metrics.shellCommands.push(String(command));
      }
    },
    trackFileChange(filePath) {
      if (filePath) {
        metrics.filesModified.push(String(filePath));
      }
    },
    trackGraphContext(context = {}) {
      const analytics = context.analytics ?? context.retrieval ?? null;
      if (!context.injected || !analytics) {
        metrics.graphContext.skippedCount += 1;
        return;
      }
      const entry = {
        workflow: context.workflow ?? metrics.workflow,
        mode: context.mode ?? metrics.mode,
        confidence: analytics.confidence ?? "LOW",
        nodeCount: Number(analytics.nodeCount ?? analytics.retrievedNodeCount ?? 0) || 0,
        edgeCount: Number(analytics.edgeCount ?? analytics.retrievedEdgeCount ?? 0) || 0,
        estimatedTokens: Number(analytics.estimatedTokens ?? 0) || 0,
        rawEstimatedTokens: Number(analytics.rawEstimatedTokens ?? analytics.estimatedTokens ?? 0) || 0,
        estimatedTokenSavings: Number(analytics.estimatedTokenSavings ?? 0) || 0,
        compressionPercent: Number(analytics.compressionPercent ?? 0) || 0,
        graphHitRate: Number(analytics.graphHitRate ?? 0) || 0,
        usefulnessScore: Number(analytics.usefulnessScore ?? 0) || 0,
        memoryEntryCount: Number(analytics.memoryEntryCount ?? 0) || 0
      };
      metrics.graphContext.retrievals.push(entry);
      metrics.graphContext.injectedCount += 1;
      metrics.graphContext.retrievedNodeCount += entry.nodeCount;
      metrics.graphContext.retrievedEdgeCount += entry.edgeCount;
      metrics.graphContext.estimatedTokens += entry.estimatedTokens;
      metrics.graphContext.rawEstimatedTokens += entry.rawEstimatedTokens;
      metrics.graphContext.estimatedTokenSavings += entry.estimatedTokenSavings;
      const retrievals = metrics.graphContext.retrievals;
      metrics.graphContext.averageUsefulnessScore = Math.round(
        retrievals.reduce((sum, item) => sum + item.usefulnessScore, 0) / retrievals.length
      );
      metrics.graphContext.averageGraphHitRate = Math.round(
        retrievals.reduce((sum, item) => sum + item.graphHitRate, 0) / retrievals.length
      );
      const confidenceRank = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
      metrics.graphContext.highestConfidence = retrievals
        .map((item) => item.confidence)
        .sort((left, right) => (confidenceRank[right] ?? 0) - (confidenceRank[left] ?? 0))[0] ?? "NONE";
    },
    absorbCodexResult(result) {
      this.trackModelUsage("codex", {
        outputText: result?.finalMessage ?? result?.rawOutput ?? ""
      });
      for (const filePath of result?.touchedFiles ?? []) {
        this.trackFileChange(filePath);
      }
      for (const command of result?.commandExecutions ?? []) {
        this.trackShellCommand(command.command);
      }
    },
    finishExecution() {
      metrics.finishedAt = Date.now();
      metrics.durationMs = metrics.startedAt ? metrics.finishedAt - metrics.startedAt : 0;
      metrics.filesModifiedCount = uniqueCount(metrics.filesModified);
      metrics.commandsExecutedCount = metrics.shellCommands.length;
      metrics.estimatedCost = estimateCost(metrics, config);
      return metrics;
    },
    snapshot() {
      return {
        ...metrics,
        filesModifiedCount: uniqueCount(metrics.filesModified),
        commandsExecutedCount: metrics.shellCommands.length,
        estimatedCost: estimateCost(metrics, config)
      };
    }
  };
}

export function renderExecutionMetrics(metrics) {
  if (!metrics) {
    return "";
  }
  const seconds = Math.max(0, Math.round((metrics.durationMs ?? 0) / 1000));
  const lines = [
    "[SYSTEM] Execution Metrics",
    "",
    "Workflow:",
    `- ${metrics.workflow ?? "unknown"}`,
    "",
    "Mode:",
    `- ${String(metrics.mode ?? "balanced").toUpperCase()}`,
    "",
    "Claude:",
    `- Input Tokens: ${metrics.claude?.inputTokens ?? 0}`,
    `- Output Tokens: ${metrics.claude?.outputTokens ?? 0}`,
    "",
    "Codex:",
    `- Input Tokens: ${metrics.codex?.inputTokens ?? 0}`,
    `- Output Tokens: ${metrics.codex?.outputTokens ?? 0}`,
    "",
    "Runtime:",
    `- ${seconds}s`,
    "",
    "Files Modified:",
    `- ${metrics.filesModifiedCount ?? uniqueCount(metrics.filesModified)}`,
    "",
    "Commands Executed:",
    `- ${metrics.commandsExecutedCount ?? metrics.shellCommands?.length ?? 0}`,
    "",
    "Estimated Cost:",
    `- $${Number(metrics.estimatedCost ?? 0).toFixed(2)}`
  ];
  const graph = metrics.graphContext;
  if (graph?.retrievals?.length) {
    const compressionPercent = graph.rawEstimatedTokens > 0
      ? Math.round((graph.estimatedTokenSavings / graph.rawEstimatedTokens) * 100)
      : 0;
    lines.push(
      "",
      "[SYSTEM] Graph Context Metrics",
      "",
      "Retrieved Nodes:",
      `- ${graph.retrievedNodeCount ?? 0}`,
      "",
      "Retrieved Edges:",
      `- ${graph.retrievedEdgeCount ?? 0}`,
      "",
      "Compressed Context:",
      `- ${compressionPercent}%`,
      "",
      "Estimated Token Savings:",
      `- ${graph.estimatedTokenSavings ?? 0}`,
      "",
      "Graph Hit Rate:",
      `- ${graph.averageGraphHitRate ?? 0}%`,
      "",
      "Retrieval Usefulness:",
      `- ${graph.averageUsefulnessScore ?? 0}/100`,
      "",
      "Retrieval Confidence:",
      `- ${graph.highestConfidence ?? "NONE"}`
    );
  }
  return lines.join("\n");
}
