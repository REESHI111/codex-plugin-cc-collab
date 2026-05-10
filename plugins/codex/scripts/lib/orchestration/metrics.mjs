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
  return [
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
  ].join("\n");
}
