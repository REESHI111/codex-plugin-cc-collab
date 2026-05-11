import { renderExecutionMetrics } from "./orchestration/metrics.mjs";

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatCodexResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `codex resume ${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/codex:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/codex:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Codex session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCodexResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Codex: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /codex:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /codex:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /codex:review --wait");
    lines.push("  Stricter review: /codex:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Codex Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- codex: ${report.codex.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    `- orchestration: ${report.orchestration?.defaultWorkflow ?? "pair"} (${(report.orchestration?.providers ?? []).join(", ") || "default providers"})`,
    `- permissions: sandbox=${report.orchestration?.sandboxMode ?? "workspace-write"}, approval=${report.orchestration?.approvalMode ?? "on-request"}, writes=${report.orchestration?.allowFileWrites === false ? "disabled" : "enabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Codex returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Codex review completed without any stdout output.");
  } else {
    lines.push("Codex review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Codex did not return a final message.";
  return `${message}\n`;
}

function appendModelBlock(lines, title, output) {
  const body = String(output ?? "").trim();
  if (!body) {
    return;
  }
  lines.push("", `## ${title}`, "", body);
}

function appendContextGraphBlock(lines, contextGraph) {
  if (!contextGraph) {
    return;
  }
  lines.push("", "[GRAPH] Context Graph");
  const retrieval = contextGraph.retrieval;
  if (retrieval) {
    lines.push(`- Retrieval: ${retrieval.injected ? "injected" : "skipped"}`);
    if (retrieval.detail) {
      lines.push(`- Retrieval Detail: ${retrieval.detail}`);
    }
    if (retrieval.analytics) {
      lines.push(`- Retrieval Confidence: ${retrieval.analytics.confidence ?? "unknown"}`);
      lines.push(`- Retrieved Nodes: ${retrieval.analytics.nodeCount ?? 0}`);
      lines.push(`- Token Savings: ${retrieval.analytics.estimatedTokenSavings ?? 0}`);
      lines.push(`- Usefulness Score: ${retrieval.analytics.usefulnessScore ?? 0}/100`);
    }
    if (retrieval.trace) {
      lines.push(`- Retrieval Duration: ${Math.round(retrieval.trace.durationMs ?? 0)}ms`);
    }
  }
  const update = contextGraph.update;
  if (update) {
    lines.push(`- Update: ${update.queued ? "queued" : update.ok ? "updated" : update.skipped ? "skipped" : "failed"}`);
    if (update.detail) {
      lines.push(`- Detail: ${update.detail}`);
    }
    if (update.workerStarted) {
      lines.push(`- Background Worker: started${update.pid ? ` (${update.pid})` : ""}`);
    }
    if (update.trace) {
      lines.push(`- Update Duration: ${Math.round(update.trace.durationMs ?? 0)}ms`);
    }
    if (update.lockBusy) {
      lines.push("- Pending Sync: recorded for the next graph update");
    }
    if (update.pendingFilesApplied?.length) {
      lines.push(`- Pending Files Applied: ${update.pendingFilesApplied.length}`);
    }
  }
  if (contextGraph.conflicts?.length) {
    lines.push("- Parallel Write Conflicts:");
    for (const conflict of contextGraph.conflicts) {
      lines.push(`  - ${conflict.filePath}: ${conflict.owners.join(", ")}`);
    }
  }
  const memory = contextGraph.memory;
  if (memory?.ok && memory.filePath) {
    lines.push(`- Memory: ${memory.filePath}`);
  }
  if (contextGraph.trace) {
    lines.push(`- Workflow Graph Trace: ${Math.round(contextGraph.trace.durationMs ?? 0)}ms`);
  }
}

export function renderCollaborationResult(result) {
  const metricsBlock = renderExecutionMetrics(result.metrics);
  if (result.workflow === "codex-inline") {
    const output = renderTaskResult({ rawOutput: result.codex?.rawOutput ?? "" }, {}).trimEnd();
    return `${[output, metricsBlock].filter(Boolean).join("\n\n")}\n`;
  }

  const title = {
    pair: "Claude + Codex Pair",
    debate: "Claude + Codex Debate",
    parallel: "Parallel Multi-Agent Run",
    collab: "Programmable Collaboration Pipeline"
  }[result.workflow] ?? "Collaborative Workflow";

  const lines = [`# ${title}`, "", result.summary ?? "Workflow completed."];

  if (result.workflow === "pair") {
    appendModelBlock(lines, "Claude Plan", result.claudePlan);
    appendModelBlock(lines, "Codex Implementation", result.codex?.rawOutput);
    appendModelBlock(lines, "Permission Diagnostic", result.codex?.permissionIssue?.message);
    if (result.codex?.touchedFiles?.length) {
      lines.push("", "Touched files:");
      for (const file of result.codex.touchedFiles) {
        lines.push(`- ${file}`);
      }
    }
  } else if (result.workflow === "debate") {
    appendModelBlock(lines, "Claude Proposal", result.claudeProposal);
    appendModelBlock(lines, "Codex Alternative", result.codex?.rawOutput);
  } else if (result.workflow === "parallel") {
    for (const output of result.outputs ?? []) {
      const statusLabel = output.ok ? "completed" : "failed";
      appendModelBlock(lines, `${output.label ?? output.providerId} (${statusLabel})`, output.rawOutput);
      appendModelBlock(lines, `${output.label ?? output.providerId} Permission Diagnostic`, output.permissionIssue?.message);
      if (output.touchedFiles?.length) {
        lines.push("", `Touched files from ${output.label ?? output.providerId}:`);
        for (const file of output.touchedFiles) {
          lines.push(`- ${file}`);
        }
      }
    }
  } else if (result.workflow === "collab") {
    if (result.pipeline?.stages?.length) {
      lines.push("", "Pipeline:");
      lines.push(`- ${result.pipeline.stages.map((stage) => `${stage.provider}:${stage.role}`).join(" -> ")}`);
    }
    for (const stage of result.stages ?? []) {
      const statusLabel = stage.ok ? "completed" : "failed";
      lines.push("", `## ${stage.label ?? stage.provider} ${stage.role} (${statusLabel})`);
      lines.push("");
      lines.push(stage.artifact?.summary ?? stage.output ?? "");
      if (stage.artifact?.decisions?.length) {
        lines.push("", "Decisions:");
        for (const decision of stage.artifact.decisions) lines.push(`- ${decision}`);
      }
      if (stage.artifact?.todos?.length) {
        lines.push("", "Todos:");
        for (const todo of stage.artifact.todos) lines.push(`- ${todo}`);
      }
      if (stage.escalation) {
        lines.push("", "Escalation: selective review triggered.");
      }
    }
    if (result.escalation?.reasons?.length) {
      lines.push("", "Escalation reasons:");
      for (const reason of result.escalation.reasons) lines.push(`- ${reason}`);
    }
  }

  if (metricsBlock) {
    lines.push("", metricsBlock);
  }
  appendContextGraphBlock(lines, result.contextGraph);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Codex Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.runtimeStatus) {
    lines.push("[SYSTEM] Runtime Status", "");
    lines.push("Sandbox:");
    lines.push(`- ${report.runtimeStatus.sandbox}`);
    lines.push("");
    lines.push("Approvals:");
    lines.push(`- ${report.runtimeStatus.approvals}`);
    lines.push("");
    lines.push("Write Access:");
    lines.push(`- ${report.runtimeStatus.writeAccess ? "enabled" : "disabled"}`);
    lines.push("");
    lines.push("Git Operations:");
    lines.push(`- ${report.runtimeStatus.gitOperations ? "enabled" : "disabled"}`);
    lines.push("");
    lines.push("Claude Executor:");
    lines.push(`- ${report.runtimeStatus.claudeExecutor}`);
    lines.push("");
    lines.push("Codex Executor:");
    lines.push(`- ${report.runtimeStatus.codexExecutor}`);
    lines.push("");
    lines.push("Current Workflow:");
    lines.push(`- ${report.runtimeStatus.currentWorkflow}`);
    lines.push("");
    lines.push("Current Mode:");
    lines.push(`- ${report.runtimeStatus.currentMode}`);
    lines.push("");
    if (report.runtimeStatus.contextGraph) {
      lines.push("Context Graph:");
      lines.push(`- ${report.runtimeStatus.contextGraph.enabled ? "enabled" : "disabled"}`);
      lines.push(`- provider: ${report.runtimeStatus.contextGraph.provider}`);
      lines.push(`- available: ${report.runtimeStatus.contextGraph.available ? "yes" : "no"}`);
      lines.push(`- graph: ${report.runtimeStatus.contextGraph.graphExists ? report.runtimeStatus.contextGraph.graphPath : "not built"}`);
      lines.push(`- nodes: ${report.runtimeStatus.contextGraph.nodeCount}`);
      lines.push(`- edges: ${report.runtimeStatus.contextGraph.edgeCount}`);
      if (report.runtimeStatus.contextGraph.memoryDir) {
        lines.push(`- memory: ${report.runtimeStatus.contextGraph.memoryCount ?? 0} entries`);
      }
      if (typeof report.runtimeStatus.contextGraph.promptInjection === "boolean") {
        lines.push(`- prompt injection: ${report.runtimeStatus.contextGraph.promptInjection ? "enabled" : "disabled"}`);
      }
      lines.push("");
    }
  }

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Codex adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Codex Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `codex resume ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.codex?.stdout === "string" && storedJob.result.codex.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Codex Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Codex session ID: ${threadId}`);
    lines.push(`Resume in Codex: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Codex Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/codex:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
