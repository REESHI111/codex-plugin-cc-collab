#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { loadOrchestrationConfig, summarizeOrchestrationConfig } from "./lib/orchestration/config.mjs";
import {
  buildRecommendedContextGraphConfig,
  createContextGraphProvider,
  GraphifyContextProvider,
  runContextGraphStressTest
} from "./lib/orchestration/context-graph.mjs";
import { normalizeWorkflowMode, resolveWorkflowMode } from "./lib/orchestration/modes.mjs";
import { sanitizeCommandPrompt } from "./lib/orchestration/sanitizer.mjs";
import {
  runCollabWorkflow,
  runCodexInlineWorkflow,
  runDebateWorkflow,
  runPairWorkflow,
  runParallelWorkflow
} from "./lib/orchestration/workflows.mjs";
import { buildPermissionProfile } from "./lib/orchestration/permissions.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderCollaborationResult,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--sandbox <mode>] [--approval <mode>] [--full-power] [--resume-last|--resume|--fresh] [prompt]",
      "  node scripts/codex-companion.mjs collab [--read-only|--full-power] [--claude-brief-file <file>] [prompt-or-pipeline]",
      "  node scripts/codex-companion.mjs codex-inline [--read-only|--full-power] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs pair [--read-only|--full-power] [--claude-plan-file <file>] [--model <model|spark>] [prompt]",
      "  node scripts/codex-companion.mjs debate [--claude-proposal-file <file>] [--model <model|spark>] [prompt]",
      "  node scripts/codex-companion.mjs parallel [--read-only|--full-power] [--agents codex,codex-fast] [prompt]",
      "  node scripts/codex-companion.mjs graph <status|config|enable|disable|init|recover|update|query|explain|path|context|view|timeline|stress> [args]",
      "  node scripts/codex-companion.mjs ccv [--json]",
      "  node scripts/codex-companion.mjs upgrade [--json]",
      "  node scripts/codex-companion.mjs mode [fast|architect|balanced] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function readJsonFileSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyDirectoryFresh(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    orchestration: summarizeOrchestrationConfig(loadOrchestrationConfig(workspaceRoot)),
    actionsTaken,
    nextSteps
  };
}

function getStateOrchestrationConfig(workspaceRoot) {
  const stateConfig = getConfig(workspaceRoot);
  return stateConfig.orchestration && typeof stateConfig.orchestration === "object" && !Array.isArray(stateConfig.orchestration)
    ? stateConfig.orchestration
    : {};
}

function setWorkflowMode(workspaceRoot, mode) {
  const normalized = normalizeWorkflowMode(mode);
  const existing = getStateOrchestrationConfig(workspaceRoot);
  setConfig(workspaceRoot, "orchestration", {
    ...existing,
    mode: {
      ...(existing.mode ?? {}),
      current: normalized
    }
  });
  return normalized;
}

async function buildRuntimeStatus(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = loadOrchestrationConfig(workspaceRoot);
  const summary = summarizeOrchestrationConfig(config);
  const availability = getCodexAvailability(cwd);
  const mode = resolveWorkflowMode(config);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const active = jobs.find((job) => job.status === "queued" || job.status === "running");
  const graphProvider = createContextGraphProvider({ cwd: workspaceRoot, config });
  const contextGraph = await graphProvider.getStatus();

  return {
    sandbox: summary.sandboxMode,
    approvals: summary.approvalMode,
    writeAccess: summary.allowFileWrites,
    gitOperations: summary.allowGitOperations,
    claudeExecutor: "active",
    codexExecutor: availability.available ? "active" : `unavailable (${availability.detail})`,
    currentWorkflow: active?.kindLabel ?? active?.kind ?? summary.defaultWorkflow,
    currentMode: mode.id,
    contextGraph
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const permissionProfile = request.write
    ? buildPermissionProfile(
        {
          permissions: {
            sandboxMode: request.sandboxMode,
            approvalMode: request.approvalMode,
            fullPower: request.fullPower
          }
        },
        {
          allowFileWrites: true,
          sandboxMode: request.sandboxMode,
          approvalMode: request.approvalMode,
          fullPower: request.fullPower
        }
      )
    : buildPermissionProfile(
        { permissions: { sandboxMode: "read-only", approvalMode: request.approvalMode ?? "on-request" } },
        { allowFileWrites: false, sandboxMode: "read-only", approvalMode: request.approvalMode }
      );

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: permissionProfile.sandboxMode,
    approvalPolicy: permissionProfile.approvalMode,
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    permissionProfile
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function renderGraphPayload(payload) {
  const lines = ["# Codex Context Graph", ""];
  if (payload.command === "status") {
    const status = payload.status;
    lines.push("[GRAPH] Runtime Status", "");
    lines.push(`- Enabled: ${status.enabled ? "yes" : "no"}`);
    lines.push(`- Provider: ${status.provider}`);
    lines.push(`- Available: ${status.available ? "yes" : "no"}`);
    lines.push(`- Graph: ${status.graphExists ? status.graphPath : "not built"}`);
    lines.push(`- Report: ${status.reportExists ? status.reportPath : "not built"}`);
    lines.push(`- Nodes: ${status.nodeCount}`);
    lines.push(`- Edges: ${status.edgeCount}`);
    if (status.memoryDir) {
      lines.push(`- Memory Dir: ${status.memoryDir}`);
      lines.push(`- Memory Entries: ${status.memoryCount ?? 0}`);
    }
    if (typeof status.promptInjection === "boolean") {
      lines.push(`- Prompt Injection: ${status.promptInjection ? "enabled" : "disabled"}`);
    }
    if (typeof status.memoryRetrieval === "boolean") {
      lines.push(`- Memory Retrieval: ${status.memoryRetrieval ? "enabled" : "disabled"}`);
    }
    if (status.lastUpdated) {
      lines.push(`- Last Updated: ${status.lastUpdated}`);
    }
    if (status.health) {
      lines.push("", "Provider Health:");
      lines.push(`- Python: ${status.health.python?.ok ? "installed" : "missing"}${status.health.python?.output ? ` (${status.health.python.output})` : ""}`);
      lines.push(`- uv: ${status.health.uv?.ok ? "installed" : "missing"}`);
      lines.push(`- pipx: ${status.health.pipx?.ok ? "installed" : "missing"}`);
      lines.push(`- pip: ${status.health.pip?.ok ? "installed" : "missing"}`);
      lines.push(`- graphify module: ${status.health.runtime?.checks?.graphify?.ok ? "ok" : status.health.runtime?.checks?.graphify?.error ?? "missing"}`);
      lines.push(`- graphifyy package: ${status.health.runtime?.checks?.graphify?.version ?? "bundled/source"}`);
      lines.push(`- graphify CLI: ${status.health.pythonModuleCli?.ok ? "ok" : status.health.pythonModuleCli?.error ?? status.health.pythonModuleCli?.output ?? "missing"}`);
    }
    if (status.workspace) {
      lines.push("", "Workspace Health:");
      lines.push(`- Output Dir: ${status.workspace.outputDirExists ? "ok" : "missing"}`);
      lines.push(`- graph.json: ${status.workspace.graph.exists ? status.workspace.graph.valid ? "valid" : "invalid" : "missing"}`);
      if (status.workspace.graph.error) {
        lines.push(`- graph.json Error: ${status.workspace.graph.error}`);
      }
      lines.push(`- Memory Layer: ${status.workspace.memoryExists ? "initialized" : "missing"}`);
      lines.push(`- Pending Updates: ${status.workspace.pendingFileCount}`);
      lines.push(`- Lock Status: ${status.lockStatus ?? "unknown"}`);
    }
    lines.push(`- Detail: ${status.detail}`);
    if (!status.enabled) {
      lines.push("", "Next steps:");
      lines.push("- Run `/codex:graph enable` to turn on context graph memory.");
      lines.push("- Then run `/codex:graph init --install` to validate dependencies and build the graph.");
    } else if (!status.available) {
      lines.push("", "Next steps:");
      lines.push("- Run `/codex:graph init --install` to bootstrap Graphify dependencies automatically.");
      lines.push("- Or install manually with `python3 -m pip install graphifyy`, then run `/codex:graph init --force`.");
      for (const step of status.healthSummary?.installPlan ?? []) {
        lines.push(`- ${step}`);
      }
    } else if (status.workspace && (!status.workspace.healthy || !status.graphValid)) {
      lines.push("", "Next steps:");
      lines.push("- Run `/codex:graph recover` to repair local graph workspace state.");
      if (!status.graphValid) {
        lines.push("- Run `/codex:graph init --force` to rebuild graph.json.");
      }
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (payload.command === "config") {
    lines.push("Recommended context graph config:", "", "```json");
    lines.push(JSON.stringify({ contextGraph: payload.contextGraph }, null, 2));
    lines.push("```");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (payload.command === "enable" || payload.command === "disable") {
    lines.push(payload.command === "enable" ? "Context graph memory mode enabled." : "Context graph memory mode disabled.");
    lines.push("");
    lines.push(`- State config updated: ${payload.updated ? "yes" : "no"}`);
    lines.push(`- Enabled: ${payload.contextGraph.enabled ? "yes" : "no"}`);
    lines.push(`- Graph: ${payload.contextGraph.graphPath}`);
    if (payload.command === "enable") {
      lines.push("", "Next steps:");
      lines.push("- Run `/codex:graph init` to validate Graphify and build the first graph.");
      lines.push("- Run `/codex:graph status` to confirm memory mode is active.");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (payload.command === "init" || payload.command === "bootstrap") {
    const result = payload.result;
    lines.push(result.ok ? "Context graph bootstrap completed." : "Context graph bootstrap needs attention.");
    lines.push("");
    lines.push(`- Runtime: ${result.runtime?.ok ? "ready" : "not ready"}`);
    if (result.install) {
      lines.push(`- Install: ${result.install.ok ? "ok" : "failed"}`);
      lines.push(`- Install Detail: ${result.install.detail}`);
    }
    if (result.recovery) {
      lines.push(`- Recovery: ${result.recovery.ok ? "ok" : "needs rebuild"}`);
      lines.push(`- Recovery Detail: ${result.recovery.detail}`);
    }
    if (result.runtime?.checks) {
      for (const [name, check] of Object.entries(result.runtime.checks)) {
        lines.push(`- ${name}: ${check.ok ? `ok${check.version ? ` (${check.version})` : ""}` : check.error ?? "missing"}`);
      }
    }
    lines.push(`- Build: ${result.build?.ok ? "ok" : result.build?.skipped ? "skipped" : "failed"}`);
    if (result.build?.detail) {
      lines.push(`- Build Detail: ${result.build.detail}`);
    }
    lines.push(`- Graph: ${result.after?.graphExists ? result.after.graphPath : "not built"}`);
    lines.push(`- Config Enabled: ${result.configEnabled ? "yes" : "no"}`);
    if (result.nextSteps?.length) {
      lines.push("", "Next steps:");
      for (const step of result.nextSteps) {
        lines.push(`- ${step}`);
      }
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (payload.command === "recover") {
    const result = payload.result;
    lines.push(result.ok ? "Context graph recovery completed." : "Context graph recovery needs attention.");
    lines.push("");
    lines.push(`- Detail: ${result.detail}`);
    if (result.actions?.length) {
      lines.push("", "Actions:");
      for (const action of result.actions) {
        lines.push(`- ${action}`);
      }
    }
    lines.push("", "Workspace:");
    lines.push(`- Output Dir: ${result.after?.outputDirExists ? "ok" : "missing"}`);
    lines.push(`- graph.json: ${result.after?.graph?.exists ? result.after.graph.valid ? "valid" : "invalid" : "missing"}`);
    lines.push(`- Memory Layer: ${result.after?.memoryExists ? "initialized" : "missing"}`);
    lines.push(`- Lock: ${result.after?.lockExists ? result.after.lockStale ? "stale" : "active" : "clear"}`);
    if (result.nextSteps?.length) {
      lines.push("", "Next steps:");
      for (const step of result.nextSteps) {
        lines.push(`- ${step}`);
      }
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (payload.command === "update") {
    lines.push(payload.result.ok ? "Graph update completed." : "Graph update did not complete.");
    lines.push("");
    lines.push(`- Detail: ${payload.result.detail}`);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (payload.command === "stress") {
    const result = payload.result;
    lines.push(result.ok ? "Context graph stress test passed." : "Context graph stress test found issues.");
    lines.push("");
    lines.push(`- Mode: ${String(result.mode ?? "balanced").toUpperCase()}`);
    lines.push(`- Iterations: ${result.iterations}`);
    lines.push(`- Query Count: ${result.queryCount}`);
    lines.push(`- Average Query Time: ${result.averageMs}ms`);
    lines.push(`- P95 Query Time: ${result.p95Ms}ms`);
    lines.push(`- Max Estimated Tokens: ${result.maxEstimatedTokens}`);
    lines.push(`- Max Retrieved Nodes: ${result.maxNodeCount}`);
    lines.push(`- Failures: ${result.failures}`);
    lines.push(`- Token Budget Overruns: ${result.tokenBudgetOverruns}`);
    lines.push(`- Stable: ${result.stable ? "yes" : "no"}`);
    lines.push(`- Detail: ${result.detail}`);
    if (result.runs?.length) {
      lines.push("", "Recent runs:");
      for (const run of result.runs.slice(-5)) {
        lines.push(`- ${run.ok ? "ok" : "failed"} ${run.durationMs}ms nodes:${run.nodeCount} tokens:${run.estimatedTokens}/${run.tokenBudget} ${run.query}${run.error ? ` - ${run.error}` : ""}`);
      }
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (!payload.result?.ok) {
    lines.push(payload.result?.error ?? payload.result?.detail ?? "Graph command failed.");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (payload.command === "query" || payload.command === "context" || payload.command === "view" || payload.command === "timeline") {
    lines.push(payload.result.text ?? "");
  } else if (payload.command === "explain") {
    const node = payload.result.node ?? {};
    lines.push(`Node: ${node.label ?? node.id ?? "unknown"}`);
    if (node.source_file) {
      lines.push(`Source: ${node.source_file}${node.source_location ? ` ${node.source_location}` : ""}`);
    }
    if (payload.result.neighbors?.length) {
      lines.push("", "Neighbors:");
      for (const neighbor of payload.result.neighbors) {
        lines.push(`- ${neighbor.label} (${neighbor.relation})${neighbor.source_file ? ` - ${neighbor.source_file}` : ""}`);
      }
    }
  } else if (payload.command === "path") {
    const steps = payload.result.path ?? [];
    if (steps.length === 0) {
      lines.push("Source and target are the same node.");
    } else {
      for (const step of steps) {
        lines.push(`- ${step.source_label} --${step.relation}--> ${step.target_label}`);
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (["codex-inline", "pair", "debate", "parallel"].includes(kind)) {
    return kind;
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, sandboxMode, approvalMode, fullPower }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    sandboxMode,
    approvalMode,
    fullPower
  };
}

function readTaskPrompt(cwd, options, positionals) {
  let prompt = "";
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  } else {
    const positionalPrompt = positionals.join(" ");
    prompt = positionalPrompt || readStdinIfPiped();
  }

  return sanitizeCommandPrompt(prompt).text;
}

function readTextInput(cwd, options, { valueOption, fileOption, fallback = "" }) {
  if (fileOption && options[fileOption]) {
    return fs.readFileSync(path.resolve(cwd, options[fileOption]), "utf8");
  }
  if (valueOption && options[valueOption]) {
    return String(options[valueOption]);
  }
  return fallback;
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "sandbox", "approval"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "full-power"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const sandboxMode = options.sandbox;
  const approvalMode = options.approval;
  const fullPower = Boolean(options["full-power"]);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      sandboxMode,
      approvalMode,
      fullPower
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        sandboxMode,
        approvalMode,
        fullPower,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function runCollaborationCommand({ cwd, workflow, title, summary, write, runner, json }) {
  const workspaceRoot = resolveCommandWorkspace({ cwd });
  ensureCodexAvailable(cwd);

  const job = createCompanionJob({
    prefix: workflow,
    kind: workflow,
    title,
    workspaceRoot,
    jobClass: "task",
    summary,
    write
  });

  await runForegroundCommand(
    job,
    async (progress) => {
      const payload = await runner(progress);
      const rendered = renderCollaborationResult(payload);
      return {
        exitStatus: payload.codex?.status ?? (payload.outputs?.some((output) => !output.ok) ? 1 : 0),
        threadId: payload.codex?.threadId ?? payload.outputs?.find((output) => output.threadId)?.threadId ?? null,
        turnId: payload.codex?.turnId ?? payload.outputs?.find((output) => output.turnId)?.turnId ?? null,
        payload,
        rendered,
        summary: payload.summary,
        jobTitle: title,
        jobClass: "task",
        write
      };
    },
    { json }
  );
}

async function handleCodexInline(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "sandbox", "approval"],
    booleanOptions: ["json", "write", "read-only", "full-power"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const task = readTaskPrompt(cwd, options, positionals);
  requireTaskRequest(task, false);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const write = !options["read-only"];
  const config = loadOrchestrationConfig(resolveWorkspaceRoot(cwd));

  await runCollaborationCommand({
    cwd,
    workflow: "codex-inline",
    title: "Codex Inline",
    summary: shorten(task),
    write,
    json: options.json,
    runner: (progress) =>
      runCodexInlineWorkflow({
        cwd,
        task,
        write,
        model,
        effort,
        config,
        permissionOptions: {
          sandboxMode: options.sandbox,
          approvalMode: options.approval,
          fullPower: Boolean(options["full-power"])
        },
        onProgress: progress
      })
  });
}

async function handleCollab(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "claude-brief", "claude-brief-file", "sandbox", "approval"],
    booleanOptions: ["json", "write", "read-only", "full-power"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const input = readTaskPrompt(cwd, options, positionals);
  requireTaskRequest(input, false);
  const claudeBrief = readTextInput(cwd, options, {
    valueOption: "claude-brief",
    fileOption: "claude-brief-file"
  });
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const write = !options["read-only"];
  const config = loadOrchestrationConfig(resolveWorkspaceRoot(cwd));

  await runCollaborationCommand({
    cwd,
    workflow: "collab",
    title: "Programmable Collaboration",
    summary: shorten(input),
    write,
    json: options.json,
    runner: (progress) =>
      runCollabWorkflow({
        cwd,
        input,
        claudeBrief,
        write,
        model,
        effort,
        config,
        permissionOptions: {
          sandboxMode: options.sandbox,
          approvalMode: options.approval,
          fullPower: Boolean(options["full-power"])
        },
        onProgress: progress
      })
  });
}

async function handlePair(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "claude-plan", "claude-plan-file", "sandbox", "approval"],
    booleanOptions: ["json", "write", "read-only", "full-power"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const task = readTaskPrompt(cwd, options, positionals);
  requireTaskRequest(task, false);
  const claudePlan = readTextInput(cwd, options, {
    valueOption: "claude-plan",
    fileOption: "claude-plan-file"
  });
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const write = !options["read-only"];
  const config = loadOrchestrationConfig(resolveWorkspaceRoot(cwd));

  await runCollaborationCommand({
    cwd,
    workflow: "pair",
    title: "Claude + Codex Pair",
    summary: shorten(task),
    write,
    json: options.json,
    runner: (progress) =>
      runPairWorkflow({
        cwd,
        task,
        claudePlan,
        write,
        model,
        effort,
        config,
        permissionOptions: {
          sandboxMode: options.sandbox,
          approvalMode: options.approval,
          fullPower: Boolean(options["full-power"])
        },
        onProgress: progress
      })
  });
}

async function handleDebate(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "claude-proposal", "claude-proposal-file"],
    booleanOptions: ["json"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const task = readTaskPrompt(cwd, options, positionals);
  requireTaskRequest(task, false);
  const claudeProposal = readTextInput(cwd, options, {
    valueOption: "claude-proposal",
    fileOption: "claude-proposal-file"
  });
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const config = loadOrchestrationConfig(resolveWorkspaceRoot(cwd));

  await runCollaborationCommand({
    cwd,
    workflow: "debate",
    title: "Claude + Codex Debate",
    summary: shorten(task),
    write: false,
    json: options.json,
    runner: (progress) =>
      runDebateWorkflow({
        cwd,
        task,
        claudeProposal,
        model,
        effort,
        config,
        onProgress: progress
      })
  });
}

async function handleParallel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "agents", "sandbox", "approval"],
    booleanOptions: ["json", "write", "read-only", "full-power"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const task = readTaskPrompt(cwd, options, positionals);
  requireTaskRequest(task, false);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const write = !options["read-only"];
  const config = loadOrchestrationConfig(resolveWorkspaceRoot(cwd));
  const agents = String(options.agents ?? "")
    .split(",")
    .map((agent) => agent.trim())
    .filter(Boolean);

  await runCollaborationCommand({
    cwd,
    workflow: "parallel",
    title: "Parallel Multi-Agent Run",
    summary: shorten(task),
    write,
    json: options.json,
    runner: (progress) =>
      runParallelWorkflow({
        cwd,
        task,
        agents,
        write,
        model,
        effort,
        config,
        permissionOptions: {
          sandboxMode: options.sandbox,
          approvalMode: options.approval,
          fullPower: Boolean(options["full-power"])
        },
        onProgress: progress
      })
  });
}

async function handleGraph(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "token-budget", "depth", "iterations", "mode", "limit"],
    booleanOptions: ["json", "force", "install"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const config = loadOrchestrationConfig(workspaceRoot);
  const command = positionals[0] ?? "status";
  const rest = positionals.slice(1);
  const provider = command === "init" || command === "bootstrap" || command === "recover"
    ? new GraphifyContextProvider({
        cwd: workspaceRoot,
        config: {
          ...config,
          contextGraph: {
            ...(config.contextGraph ?? {}),
            enabled: true
          }
        }
      })
    : createContextGraphProvider({ cwd: workspaceRoot, config });

  let payload;
  if (command === "status") {
    payload = {
      command,
      status: await provider.getStatus()
    };
  } else if (command === "config") {
    payload = {
      command,
      contextGraph: buildRecommendedContextGraphConfig({
        ...(config.contextGraph ?? {}),
        enabled: true
      })
    };
  } else if (command === "enable") {
    const existing = getStateOrchestrationConfig(workspaceRoot);
    const contextGraph = buildRecommendedContextGraphConfig({
      ...(existing.contextGraph ?? {}),
      enabled: true
    });
    setConfig(workspaceRoot, "orchestration", {
      ...existing,
      contextGraph
    });
    payload = {
      command,
      updated: true,
      contextGraph
    };
  } else if (command === "disable") {
    const existing = getStateOrchestrationConfig(workspaceRoot);
    const contextGraph = {
      ...buildRecommendedContextGraphConfig(existing.contextGraph ?? {}),
      enabled: false,
      injectIntoPrompts: false,
      memoryRetrieval: false
    };
    setConfig(workspaceRoot, "orchestration", {
      ...existing,
      contextGraph
    });
    payload = {
      command,
      updated: true,
      contextGraph
    };
  } else if (command === "init" || command === "bootstrap") {
    payload = {
      command,
      result: await provider.bootstrap({
        force: Boolean(options.force),
        install: Boolean(options.install),
        configEnabled: config.contextGraph?.enabled === true
      })
    };
  } else if (command === "recover") {
    payload = {
      command,
      result: provider.recoverWorkspace({
        clearLock: Boolean(options.force)
      })
    };
  } else if (command === "update") {
    payload = {
      command,
      result: await provider.updateFiles(["."], { force: Boolean(options.force), fullWorkspace: true })
    };
  } else if (command === "query") {
    const query = rest.join(" ").trim();
    if (!query) {
      throw new Error("Provide a graph query.");
    }
    payload = {
      command,
      query,
      result: await provider.queryGraph(query, {
        tokenBudget: options["token-budget"],
        depth: options.depth
      })
    };
  } else if (command === "context") {
    const query = rest.join(" ").trim();
    if (!query) {
      throw new Error("Provide a task or topic for graph context.");
    }
    payload = {
      command,
      query,
      result: await provider.getTaskContext(query, {
        tokenBudget: options["token-budget"],
        depth: options.depth
      })
    };
  } else if (command === "view") {
    const view = rest[0] ?? "overview";
    payload = {
      command,
      view,
      result: await provider.graphView(view, {
        limit: options.limit
      })
    };
  } else if (command === "timeline") {
    payload = {
      command,
      result: await provider.graphTimeline({
        limit: options.limit,
        type: rest[0]
      })
    };
  } else if (command === "stress") {
    const query = rest.join(" ").trim();
    payload = {
      command,
      query,
      result: await runContextGraphStressTest({
        cwd: workspaceRoot,
        config,
        queries: query ? [query] : [],
        iterations: options.iterations,
        tokenBudget: options["token-budget"],
        mode: options.mode ?? config.mode?.current ?? config.mode?.default
      })
    };
  } else if (command === "explain") {
    const query = rest.join(" ").trim();
    if (!query) {
      throw new Error("Provide a node or concept to explain.");
    }
    payload = {
      command,
      query,
      result: await provider.explainNode(query, {
        tokenBudget: options["token-budget"],
        depth: options.depth
      })
    };
  } else if (command === "path") {
    if (rest.length < 2) {
      throw new Error("Provide source and target labels for graph path.");
    }
    const [source, ...targetParts] = rest;
    const target = targetParts.join(" ").trim();
    payload = {
      command,
      source,
      target,
      result: await provider.shortestPath(source, target, {
        tokenBudget: options["token-budget"],
        depth: options.depth
      })
    };
  } else {
    throw new Error(`Unknown graph command "${command}". Use status, config, enable, disable, init, recover, update, query, explain, path, context, view, timeline, or stress.`);
  }

  outputCommandResult(payload, renderGraphPayload(payload), options.json);
}

async function handleGraphSyncWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const config = loadOrchestrationConfig(workspaceRoot);
  const provider = createContextGraphProvider({ cwd: workspaceRoot, config });
  await provider.updateFiles(["."], {
    reason: "background-sync-worker",
    fullWorkspace: true
  });
}

async function handleCcv(argv) {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json"]
  });
  const pluginRoot = ROOT_DIR;
  const pluginManifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const repoPackagePath = path.resolve(pluginRoot, "..", "..", "package.json");
  const marketplacePath = path.resolve(pluginRoot, "..", "..", ".claude-plugin", "marketplace.json");
  const pluginManifest = readJsonFileSafe(pluginManifestPath, {});
  const repoPackage = readJsonFileSafe(repoPackagePath, {});
  const marketplace = readJsonFileSafe(marketplacePath, {});
  const graphifyPaths = [
    path.join(pluginRoot, "graphify-7"),
    path.resolve(pluginRoot, "..", "graphify-7"),
    path.resolve(pluginRoot, "..", "..", "graphify-7")
  ];
  const graphifyDetectedPaths = graphifyPaths.filter((candidate) => fs.existsSync(path.join(candidate, "graphify", "__init__.py")));
  const provider = new GraphifyContextProvider({
    cwd: process.cwd(),
    config: {
      contextGraph: {
        enabled: true
      }
    }
  });
  const runtime = await provider.checkRuntime();
  const payload = {
    name: pluginManifest.name ?? "codex",
    pluginVersion: pluginManifest.version ?? null,
    repoVersion: repoPackage.version ?? null,
    marketplaceVersion: marketplace.version ?? marketplace.metadata?.version ?? marketplace.plugin?.version ?? marketplace.plugins?.find?.((plugin) => plugin.name === "codex")?.version ?? null,
    pluginRoot,
    scriptPath: fileURLToPath(import.meta.url),
    graphifyBundled: graphifyDetectedPaths.length > 0,
    graphifyPaths: graphifyDetectedPaths,
    graphifyRuntimeReady: runtime.ok === true,
    graphifyRuntime: runtime
  };

  if (options.json) {
    outputResult(payload, true);
    return;
  }

  const lines = [
    "# Codex Collab Version",
    "",
    "[SYSTEM] Plugin Version Check",
    "",
    `- Plugin: ${payload.name}`,
    `- Plugin Version: ${payload.pluginVersion ?? "unknown"}`,
    `- Repo Package Version: ${payload.repoVersion ?? "unknown"}`,
    `- Marketplace Version: ${payload.marketplaceVersion ?? "unknown"}`,
    `- Plugin Root: ${payload.pluginRoot}`,
    `- Script: ${payload.scriptPath}`,
    `- Graphify Bundled: ${payload.graphifyBundled ? "yes" : "no"}`,
    `- Graphify Runtime: ${payload.graphifyRuntimeReady ? "ready" : "not ready"}`
  ];
  if (payload.graphifyPaths.length) {
    lines.push("- Graphify Source:");
    for (const graphifyPath of payload.graphifyPaths) {
      lines.push(`  - ${graphifyPath}`);
    }
  }
  if (!payload.graphifyRuntimeReady) {
    lines.push("", "Next steps:");
    lines.push(`- Run \`${payload.graphifyRuntime.installCommand ?? "python3 -m pip install graphifyy"}\`.`);
    lines.push("- Reload plugins after updating or reinstalling the marketplace package.");
  }
  outputResult(`${lines.join("\n").trimEnd()}\n`, false);
}

async function handleUpgrade(argv) {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json"]
  });
  const claudePluginsRoot = path.join(process.env.HOME ?? "", ".claude", "plugins");
  const marketplaceName = "codex-collab";
  const pluginName = "codex";
  const marketplaceRoot = path.join(claudePluginsRoot, "marketplaces", marketplaceName);
  const marketplaceJsonPath = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  const installedPluginsPath = path.join(claudePluginsRoot, "installed_plugins.json");
  const steps = [];

  if (!fs.existsSync(marketplaceRoot)) {
    throw new Error(`Marketplace clone not found: ${marketplaceRoot}. Run /plugin marketplace add REESHI111/codex-plugin-cc-collab first.`);
  }

  const fetch = runCommand("git", ["fetch", "origin", "main"], {
    cwd: marketplaceRoot,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000
  });
  steps.push({
    name: "fetch marketplace",
    ok: !fetch.error && fetch.status === 0,
    detail: fetch.error?.message ?? fetch.stderr.trim() ?? fetch.stdout.trim() ?? "fetched"
  });
  if (fetch.error || fetch.status !== 0) {
    throw new Error(`Could not fetch marketplace updates: ${steps.at(-1).detail}`);
  }

  const merge = runCommand("git", ["merge", "--ff-only", "origin/main"], {
    cwd: marketplaceRoot,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000
  });
  steps.push({
    name: "fast-forward marketplace",
    ok: !merge.error && merge.status === 0,
    detail: merge.error?.message ?? merge.stderr.trim() ?? merge.stdout.trim() ?? "up to date"
  });
  if (merge.error || merge.status !== 0) {
    throw new Error(`Marketplace has local changes or cannot fast-forward: ${steps.at(-1).detail}`);
  }

  const marketplace = readJsonFileSafe(marketplaceJsonPath, {});
  const pluginEntry = marketplace.plugins?.find?.((plugin) => plugin.name === pluginName);
  if (!pluginEntry?.source || !pluginEntry.version) {
    throw new Error(`Marketplace entry for ${pluginName}@${marketplaceName} is missing source/version metadata.`);
  }
  const sourcePath = path.resolve(marketplaceRoot, pluginEntry.source);
  const cachePath = path.join(claudePluginsRoot, "cache", marketplaceName, pluginName, pluginEntry.version);
  copyDirectoryFresh(sourcePath, cachePath);
  steps.push({
    name: "copy plugin cache",
    ok: true,
    detail: cachePath
  });

  const commit = runCommand("git", ["rev-parse", "HEAD"], {
    cwd: marketplaceRoot,
    maxBuffer: 1024 * 1024
  });
  const installed = readJsonFileSafe(installedPluginsPath, { version: 2, plugins: {} });
  installed.version ??= 2;
  installed.plugins ??= {};
  const key = `${pluginName}@${marketplaceName}`;
  const existing = installed.plugins[key]?.[0] ?? {};
  installed.plugins[key] = [
    {
      scope: existing.scope ?? "user",
      installPath: cachePath,
      version: pluginEntry.version,
      installedAt: existing.installedAt ?? new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      gitCommitSha: commit.status === 0 ? commit.stdout.trim() : existing.gitCommitSha ?? null
    }
  ];
  writeJsonFile(installedPluginsPath, installed);
  steps.push({
    name: "update installed plugin pointer",
    ok: true,
    detail: `${key} -> ${pluginEntry.version}`
  });

  const payload = {
    ok: true,
    marketplace: marketplaceName,
    plugin: pluginName,
    version: pluginEntry.version,
    cachePath,
    installedPluginsPath,
    steps,
    nextSteps: [
      "/reload-plugins",
      "/codex:ccv"
    ]
  };
  if (options.json) {
    outputResult(payload, true);
    return;
  }
  const lines = [
    "# Codex Collab Upgrade",
    "",
    "[SYSTEM] Plugin Upgrade",
    "",
    `- Marketplace: ${marketplaceName}`,
    `- Plugin: ${pluginName}`,
    `- Installed Version: ${pluginEntry.version}`,
    `- Cache: ${cachePath}`,
    "",
    "Steps:"
  ];
  for (const step of steps) {
    lines.push(`- ${step.ok ? "ok" : "failed"}: ${step.name} - ${step.detail}`);
  }
  lines.push("", "Next steps:");
  for (const step of payload.nextSteps) {
    lines.push(`- ${step}`);
  }
  outputResult(`${lines.join("\n").trimEnd()}\n`, false);
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  const runtimeStatus = await buildRuntimeStatus(cwd);
  const enrichedReport = {
    ...report,
    runtimeStatus
  };
  outputResult(renderStatusPayload(enrichedReport, options.json), options.json);
}

function handleMode(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const requested = positionals[0] ?? "";
  if (requested) {
    const mode = setWorkflowMode(workspaceRoot, requested);
    const payload = {
      mode,
      status: "updated"
    };
    outputCommandResult(payload, `[SYSTEM]\nWorkflow Mode: ${mode.toUpperCase()}\n`, options.json);
    return;
  }

  const config = loadOrchestrationConfig(workspaceRoot);
  const mode = resolveWorkflowMode(config);
  const payload = {
    mode: mode.id,
    status: "current"
  };
  outputCommandResult(payload, `[SYSTEM]\nWorkflow Mode: ${mode.label}\n`, options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "codex-inline":
      await handleCodexInline(argv);
      break;
    case "collab":
      await handleCollab(argv);
      break;
    case "pair":
      await handlePair(argv);
      break;
    case "debate":
      await handleDebate(argv);
      break;
    case "parallel":
      await handleParallel(argv);
      break;
    case "graph":
      await handleGraph(argv);
      break;
    case "ccv":
      await handleCcv(argv);
      break;
    case "upgrade":
      await handleUpgrade(argv);
      break;
    case "graph-sync-worker":
      await handleGraphSyncWorker(argv);
      break;
    case "mode":
      handleMode(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
