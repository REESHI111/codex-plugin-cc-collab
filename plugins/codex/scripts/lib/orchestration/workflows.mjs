import {
  buildCodexInlinePrompt,
  buildDebateAlternativePrompt,
  buildPairImplementationPrompt,
  buildParallelAgentPrompt
} from "./prompts.mjs";
import { createExecutor } from "./executors.mjs";
import { createLoopGuard, resolveLoopLimits } from "./loop-protection.mjs";
import { createMetricsCollector } from "./metrics.mjs";
import { applyWorkflowMode, resolveWorkflowMode } from "./modes.mjs";
import { buildPermissionProfile } from "./permissions.mjs";

function firstLine(text, fallback) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? fallback
  );
}

function getProvider(config, providerId) {
  const provider = config.providers?.[providerId];
  if (!provider) {
    throw new Error(`Unknown model provider "${providerId}". Add it to codex-companion.config.json.`);
  }
  return provider;
}

function buildExecutionOptions(config, options = {}) {
  const loopLimits = resolveLoopLimits(config);
  return {
    retries: Math.min(Number(options.retries ?? config.execution?.retries ?? 0) || 0, loopLimits.maxRetries),
    timeoutMs: options.timeoutMs ?? config.execution?.timeoutMs ?? 0
  };
}

function normalizeCodexResult(result, label) {
  return {
    label,
    status: result.status,
    threadId: result.threadId ?? null,
    turnId: result.turnId ?? null,
    rawOutput: result.finalMessage ?? "",
    reasoningSummary: result.reasoningSummary ?? [],
    touchedFiles: result.touchedFiles ?? [],
    permissionProfile: result.permissionProfile ?? null,
    permissionIssue: result.permissionIssue ?? null,
    commandExecutions: result.commandExecutions ?? []
  };
}

export async function runCodexInlineWorkflow({ cwd, task, write = true, model, effort, config, permissionOptions, onProgress }) {
  const mode = resolveWorkflowMode(config);
  config = applyWorkflowMode(config, mode.id);
  const loopGuard = createLoopGuard(config);
  loopGuard.assertCanStart("codex-inline");
  loopGuard.trackIteration("codex-inline");
  loopGuard.trackPrompt(task);
  const metrics = createMetricsCollector(config);
  metrics.startExecution({ workflow: "codex-inline", mode: mode.id });
  const providerId = config.routing?.implementer ?? "codex";
  const provider = getProvider(config, providerId);
  const executor = createExecutor(providerId, provider);
  const prompt = buildCodexInlinePrompt({
    task,
    strategyName: mode.id === "architect" ? "concise" : "fast"
  });
  metrics.trackModelUsage("codex", { inputText: prompt });
  const permissionProfile = buildPermissionProfile(config, {
    allowFileWrites: write !== false,
    ...permissionOptions
  });

  onProgress?.({ message: `[CODEX] Implementing directly.`, phase: "implementing" });
  const result = await executor.executeTask(
    { prompt },
    {
      cwd,
      write,
      model,
      effort,
      onProgress,
      config,
      permissionProfile,
      persistThread: true,
      threadName: `Codex Inline: ${firstLine(task, "task")}`,
      ...buildExecutionOptions(config)
    }
  );
  metrics.absorbCodexResult(result);
  const finalMetrics = metrics.finishExecution();

  return {
    workflow: "codex-inline",
    mode: mode.id,
    summary: firstLine(result.finalMessage, "Codex inline task completed."),
    codex: normalizeCodexResult(result, executor.label),
    metrics: finalMetrics
  };
}

export async function runPairWorkflow({ cwd, task, claudePlan, write = true, model, effort, config, permissionOptions, onProgress }) {
  if (!claudePlan?.trim()) {
    throw new Error("Pair workflow requires --claude-plan or piped Claude plan text.");
  }

  const mode = resolveWorkflowMode(config);
  config = applyWorkflowMode(config, mode.id);
  const loopGuard = createLoopGuard(config);
  loopGuard.assertCanStart("pair");
  loopGuard.trackIteration("pair");
  loopGuard.trackPrompt(`${task}\n${claudePlan}`);
  const metrics = createMetricsCollector(config);
  metrics.startExecution({ workflow: "pair", mode: mode.id });
  metrics.trackModelUsage("claude", {
    inputText: task,
    outputText: claudePlan
  });

  const providerId = config.routing?.implementer ?? "codex";
  const provider = getProvider(config, providerId);
  const executor = createExecutor(providerId, provider);
  const prompt = buildPairImplementationPrompt({
    task,
    claudePlan,
    strategyName: mode.promptStrategy
  });
  metrics.trackModelUsage("codex", { inputText: prompt });

  const permissionProfile = buildPermissionProfile(config, {
    allowFileWrites: write !== false,
    ...permissionOptions
  });

  onProgress?.({ message: `[CODEX] Implementing Claude's plan.`, phase: "implementing" });
  const result = await executor.executeTask(
    { prompt },
    {
      cwd,
      write,
      model,
      effort,
      onProgress,
      config,
      permissionProfile,
      persistThread: true,
      threadName: `Pair: ${firstLine(task, "collaborative task")}`,
      ...buildExecutionOptions(config)
    }
  );
  metrics.absorbCodexResult(result);
  const finalMetrics = metrics.finishExecution();

  return {
    workflow: "pair",
    mode: mode.id,
    summary: firstLine(result.finalMessage, "Pair implementation completed."),
    task,
    claudePlan,
    codex: normalizeCodexResult(result, executor.label),
    metrics: finalMetrics
  };
}

export async function runDebateWorkflow({ cwd, task, claudeProposal, model, effort, config, onProgress }) {
  if (!claudeProposal?.trim()) {
    throw new Error("Debate workflow requires --claude-proposal or piped Claude proposal text.");
  }

  const mode = resolveWorkflowMode(config);
  config = applyWorkflowMode(config, mode.id);
  const loopGuard = createLoopGuard(config);
  loopGuard.assertCanStart("debate");
  loopGuard.trackIteration("debate");
  loopGuard.trackPrompt(`${task}\n${claudeProposal}`);
  const metrics = createMetricsCollector(config);
  metrics.startExecution({ workflow: "debate", mode: mode.id });
  metrics.trackModelUsage("claude", {
    inputText: task,
    outputText: claudeProposal
  });

  const providerId = config.routing?.implementer ?? "codex";
  const provider = getProvider(config, providerId);
  const executor = createExecutor(providerId, provider);
  const prompt = buildDebateAlternativePrompt({
    task,
    claudeProposal,
    strategyName: mode.id === "fast" ? "concise" : "rigorous"
  });
  metrics.trackModelUsage("codex", { inputText: prompt });

  onProgress?.({ message: `[CODEX] Preparing alternative proposal.`, phase: "debating" });
  const result = await executor.executeTask(
    { prompt },
    {
      cwd,
      write: false,
      model,
      effort,
      onProgress,
      config,
      permissionProfile: buildPermissionProfile(config, {
        allowFileWrites: false,
        sandboxMode: "read-only"
      }),
      persistThread: false,
      threadName: `Debate: ${firstLine(task, "decision")}`,
      ...buildExecutionOptions(config)
    }
  );
  metrics.absorbCodexResult(result);
  const finalMetrics = metrics.finishExecution();

  return {
    workflow: "debate",
    mode: mode.id,
    summary: firstLine(result.finalMessage, "Debate alternative completed."),
    task,
    claudeProposal,
    codex: normalizeCodexResult(result, executor.label),
    metrics: finalMetrics
  };
}

export async function runParallelWorkflow({ cwd, task, agents, write = true, model, effort, config, permissionOptions, onProgress }) {
  const mode = resolveWorkflowMode(config);
  config = applyWorkflowMode(config, mode.id);
  const loopGuard = createLoopGuard(config);
  loopGuard.assertCanStart("parallel");
  loopGuard.trackIteration("parallel");
  loopGuard.trackPrompt(task);
  const metrics = createMetricsCollector(config);
  metrics.startExecution({ workflow: "parallel", mode: mode.id });
  const configuredAgents = agents?.length ? agents : config.execution?.parallelAgents ?? ["codex"];
  const uniqueAgents = [...new Set(configuredAgents)];
  if (uniqueAgents.length === 0) {
    throw new Error("Parallel workflow requires at least one agent.");
  }
  if (write !== false && uniqueAgents.length > 1 && config.execution?.allowConcurrentWrites !== true) {
    throw new Error(
      "Parallel write mode with multiple agents is disabled to avoid conflicting edits. Use --read-only, run one writer, or set execution.allowConcurrentWrites=true."
    );
  }

  const runs = uniqueAgents.map(async (providerId) => {
    const provider = getProvider(config, providerId);
    const executor = createExecutor(providerId, provider);
    const prompt = buildParallelAgentPrompt({
      task,
      agentLabel: executor.label,
      strategyName: mode.promptStrategy
    });
    metrics.trackModelUsage("codex", { inputText: prompt });
    const permissionProfile = buildPermissionProfile(config, {
      allowFileWrites: write !== false,
      ...permissionOptions
    });
    onProgress?.({ message: `[${executor.label.toUpperCase()}] Running parallel agent.`, phase: "parallel" });
    const result = await executor.executeTask(
      { prompt },
      {
        cwd,
        write,
        model: providerId === "codex" ? model : provider.model,
        effort: providerId === "codex" ? effort : provider.effort,
        onProgress,
        config,
        permissionProfile,
        persistThread: true,
        threadName: `Parallel ${executor.label}: ${firstLine(task, "task")}`,
        ...buildExecutionOptions(config)
      }
    );
    return normalizeCodexResult(result, executor.label);
  });

  const settled = await Promise.allSettled(runs);
  const outputs = settled.map((entry, index) => {
    const providerId = uniqueAgents[index];
    if (entry.status === "fulfilled") {
      return {
        providerId,
        ok: true,
        ...entry.value
      };
    }
    return {
      providerId,
      label: providerId,
      ok: false,
      status: 1,
      rawOutput: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
      reasoningSummary: [],
      touchedFiles: []
    };
  });
  for (const output of outputs) {
    metrics.trackModelUsage("codex", { outputText: output.rawOutput });
    for (const filePath of output.touchedFiles ?? []) {
      metrics.trackFileChange(filePath);
    }
    for (const command of output.commandExecutions ?? []) {
      metrics.trackShellCommand(command.command);
    }
  }
  const finalMetrics = metrics.finishExecution();

  return {
    workflow: "parallel",
    mode: mode.id,
    summary: `${outputs.filter((output) => output.ok).length}/${outputs.length} parallel agent(s) completed.`,
    task,
    outputs,
    metrics: finalMetrics
  };
}
