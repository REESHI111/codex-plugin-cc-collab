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
import { retrieveContextGraphForTask, updateContextGraphAfterWorkflow } from "./context-graph.mjs";
import {
  buildStageArtifact,
  parseCollabPipeline,
  pipelineDiagram,
  shouldEscalateCollab
} from "./collab.mjs";

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

function buildCollabStagePrompt({ task, stage, artifacts = [], contextGraphText = "" }) {
  const prior = artifacts.length
    ? artifacts.map((artifact) => [
        `Stage ${artifact.provider}:${artifact.role}`,
        `Summary: ${artifact.summary}`,
        artifact.decisions?.length ? `Decisions: ${artifact.decisions.join("; ")}` : "",
        artifact.todos?.length ? `Todos: ${artifact.todos.join("; ")}` : "",
        artifact.risks?.length ? `Risks: ${artifact.risks.join("; ")}` : ""
      ].filter(Boolean).join("\n")).join("\n\n")
    : "No prior stage artifacts.";
  return [
    `You are ${stage.provider} executing the "${stage.role}" stage in a deterministic collaboration pipeline.`,
    "Use only the bounded structured artifacts below; do not ask other agents to run recursively.",
    "Return a compact result with: summary, decisions, todos, risks, and verification.",
    "",
    "User task:",
    task,
    "",
    "Prior stage artifacts:",
    prior,
    contextGraphText ? `\nRelevant context graph:\n${contextGraphText}` : ""
  ].filter(Boolean).join("\n");
}

function claudeStageOutput({ stage, task, artifacts = [], claudeBrief = "" }) {
  if (claudeBrief.trim()) {
    return claudeBrief.trim();
  }
  const prior = artifacts.map((artifact) => `${artifact.provider}:${artifact.role} ${artifact.summary}`).join("\n");
  return [
    `Claude ${stage.role} stage completed as a bounded command-side artifact.`,
    `Task: ${task}`,
    prior ? `Prior context:\n${prior}` : "",
    "Decisions: use the structured pipeline order and keep context transfer bounded.",
    "Todos: execute the next supported provider stage and verify only when risk requires it.",
    "Risks: avoid recursive orchestration and unbounded conversation history transfer."
  ].filter(Boolean).join("\n");
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
  const contextGraph = await retrieveContextGraphForTask({
    cwd,
    config,
    task,
    workflow: "codex-inline",
    mode: mode.id,
    onProgress
  });
  metrics.trackGraphContext(contextGraph);
  const prompt = buildCodexInlinePrompt({
    task,
    strategyName: mode.id === "architect" ? "concise" : "fast",
    contextGraphText: contextGraph.text
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
  const payload = {
    workflow: "codex-inline",
    mode: mode.id,
    summary: firstLine(result.finalMessage, "Codex inline task completed."),
    task,
    codex: normalizeCodexResult(result, executor.label),
    metrics: finalMetrics
  };
  payload.contextGraph = {
    retrieval: contextGraph,
    ...(await updateContextGraphAfterWorkflow({ cwd, config, workflowResult: payload, onProgress }))
  };
  return payload;
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
  const contextGraph = await retrieveContextGraphForTask({
    cwd,
    config,
    task,
    workflow: "pair",
    mode: mode.id,
    onProgress
  });
  metrics.trackGraphContext(contextGraph);
  const prompt = buildPairImplementationPrompt({
    task,
    claudePlan,
    strategyName: mode.promptStrategy,
    contextGraphText: contextGraph.text
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
  const payload = {
    workflow: "pair",
    mode: mode.id,
    summary: firstLine(result.finalMessage, "Pair implementation completed."),
    task,
    claudePlan,
    codex: normalizeCodexResult(result, executor.label),
    metrics: finalMetrics
  };
  payload.contextGraph = {
    retrieval: contextGraph,
    ...(await updateContextGraphAfterWorkflow({ cwd, config, workflowResult: payload, onProgress }))
  };
  return payload;
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
  const contextGraph = await retrieveContextGraphForTask({
    cwd,
    config,
    task,
    workflow: "debate",
    mode: mode.id,
    onProgress
  });
  metrics.trackGraphContext(contextGraph);
  const prompt = buildDebateAlternativePrompt({
    task,
    claudeProposal,
    strategyName: mode.id === "fast" ? "concise" : "rigorous",
    contextGraphText: contextGraph.text
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
  const payload = {
    workflow: "debate",
    mode: mode.id,
    summary: firstLine(result.finalMessage, "Debate alternative completed."),
    task,
    claudeProposal,
    codex: normalizeCodexResult(result, executor.label),
    metrics: finalMetrics
  };
  payload.contextGraph = {
    retrieval: contextGraph,
    ...(await updateContextGraphAfterWorkflow({ cwd, config, workflowResult: payload, onProgress }))
  };
  return payload;
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
  const contextGraph = await retrieveContextGraphForTask({
    cwd,
    config,
    task,
    workflow: "parallel",
    mode: mode.id,
    onProgress
  });
  metrics.trackGraphContext(contextGraph);

  const runs = uniqueAgents.map(async (providerId) => {
    const provider = getProvider(config, providerId);
    const executor = createExecutor(providerId, provider);
    const prompt = buildParallelAgentPrompt({
      task,
      agentLabel: executor.label,
      strategyName: mode.promptStrategy,
      contextGraphText: contextGraph.text
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
  const payload = {
    workflow: "parallel",
    mode: mode.id,
    summary: `${outputs.filter((output) => output.ok).length}/${outputs.length} parallel agent(s) completed.`,
    task,
    outputs,
    metrics: finalMetrics
  };
  payload.contextGraph = {
    retrieval: contextGraph,
    ...(await updateContextGraphAfterWorkflow({ cwd, config, workflowResult: payload, onProgress }))
  };
  return payload;
}

export async function runCollabWorkflow({ cwd, input, claudeBrief = "", write = true, model, effort, config, permissionOptions, onProgress }) {
  const mode = resolveWorkflowMode(config);
  config = applyWorkflowMode(config, mode.id);
  const pipeline = parseCollabPipeline(input, config);
  const task = pipeline.task || input;
  const loopGuard = createLoopGuard(config);
  loopGuard.assertCanStart("collab");
  loopGuard.trackIteration("collab");
  loopGuard.trackPrompt(`${task}\n${pipelineDiagram(pipeline.stages)}`);

  const metrics = createMetricsCollector(config);
  metrics.startExecution({ workflow: "collab", mode: mode.id });
  const contextGraph = await retrieveContextGraphForTask({
    cwd,
    config,
    task,
    workflow: "collab",
    mode: mode.id,
    onProgress
  });
  metrics.trackGraphContext(contextGraph);

  const artifacts = [];
  const stageResults = [];
  let lastCodex = null;
  for (const [index, stage] of pipeline.stages.entries()) {
    const provider = getProvider(config, stage.provider);
    const executor = createExecutor(stage.provider, provider);
    const startedAt = Date.now();
    onProgress?.({ message: `[${executor.label.toUpperCase()}] ${stage.role}.`, phase: "collab" });

    if (provider.type === "claude" || stage.provider === "claude") {
      const output = claudeStageOutput({ stage, task, artifacts, claudeBrief: index === 0 ? claudeBrief : "" });
      metrics.trackModelUsage("claude", { inputText: task, outputText: output });
      const artifact = buildStageArtifact({ stage, output, previousArtifacts: artifacts, task });
      artifacts.push(artifact);
      stageResults.push({
        ...stage,
        label: executor.label,
        ok: true,
        skippedExecution: true,
        durationMs: Date.now() - startedAt,
        artifact,
        output
      });
      continue;
    }

    const roleIsWrite = stage.role.startsWith("implement") || ["refactor", "migrate"].includes(stage.role);
    const prompt = buildCollabStagePrompt({
      task,
      stage,
      artifacts,
      contextGraphText: contextGraph.text
    });
    metrics.trackModelUsage(stage.provider === "codex" ? "codex" : "codex", { inputText: prompt });
    const permissionProfile = buildPermissionProfile(config, {
      allowFileWrites: write !== false && roleIsWrite,
      ...permissionOptions
    });
    const result = await executor.executeTask(
      { prompt },
      {
        cwd,
        write: write !== false && roleIsWrite,
        model: stage.provider === "codex" ? model : provider.model,
        effort: stage.provider === "codex" ? effort : provider.effort,
        onProgress,
        config,
        permissionProfile,
        persistThread: true,
        threadName: `Collab ${executor.label}: ${stage.role}`,
        ...buildExecutionOptions(config)
      }
    );
    metrics.absorbCodexResult(result);
    const artifact = buildStageArtifact({
      stage,
      output: result.finalMessage ?? result.rawOutput ?? "",
      previousArtifacts: artifacts,
      task
    });
    artifacts.push(artifact);
    const normalized = normalizeCodexResult(result, executor.label);
    if (stage.provider === "codex") {
      lastCodex = normalized;
    }
    stageResults.push({
      ...stage,
      label: executor.label,
      ok: result.status === 0,
      durationMs: Date.now() - startedAt,
      artifact,
      result: normalized,
      output: normalized.rawOutput
    });
  }

  let finalMetrics = metrics.snapshot();
  const escalation = shouldEscalateCollab({ stageResults, metrics: finalMetrics, config });
  const hasExplicitReview = pipeline.stages.some((stage) => stage.role === "review");
  if (escalation.escalate && !hasExplicitReview && config.collab?.autoEscalate !== false) {
    const stage = { id: `stage-${pipeline.stages.length + 1}`, provider: "claude", role: "review", source: "escalation" };
    const output = [
      "Selective escalation review requested.",
      `Reasons: ${escalation.reasons.join("; ")}`,
      `Latest artifact: ${artifacts.at(-1)?.summary ?? "none"}`,
      "Todos: inspect the changed files and run targeted verification before shipping."
    ].join("\n");
    metrics.trackModelUsage("claude", { inputText: task, outputText: output });
    const artifact = buildStageArtifact({ stage, output, previousArtifacts: artifacts, task });
    artifacts.push(artifact);
    stageResults.push({
      ...stage,
      label: "Claude",
      ok: true,
      escalation: true,
      durationMs: 0,
      artifact,
      output
    });
  }

  finalMetrics = metrics.finishExecution();
  const payload = {
    workflow: "collab",
    mode: mode.id,
    summary: `Collaboration pipeline completed: ${pipelineDiagram(pipeline.stages)}.`,
    task,
    pipeline,
    stages: stageResults,
    artifacts,
    escalation,
    codex: lastCodex,
    metrics: finalMetrics
  };
  payload.contextGraph = {
    retrieval: contextGraph,
    ...(await updateContextGraphAfterWorkflow({ cwd, config, workflowResult: payload, onProgress }))
  };
  return payload;
}
