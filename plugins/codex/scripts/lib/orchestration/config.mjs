import fs from "node:fs";
import path from "node:path";

import { getConfig } from "../state.mjs";

const CONFIG_FILE_NAMES = [
  "codex-companion.config.json",
  path.join(".codex-companion", "config.json")
];

export const DEFAULT_ORCHESTRATION_CONFIG = {
  version: 1,
  defaultWorkflow: "pair",
  routing: {
    planner: "claude",
    implementer: "codex",
    reviewer: "claude"
  },
  providers: {
    claude: {
      type: "claude",
      label: "Claude"
    },
    codex: {
      type: "codex",
      label: "Codex",
      model: null,
      effort: null
    }
  },
  execution: {
    timeoutMs: 0,
    retries: 0,
    parallelAgents: ["codex"],
    allowConcurrentWrites: false
  },
  mode: {
    default: "balanced",
    current: "balanced"
  },
  loopProtection: {
    maxDepth: 4,
    maxIterations: 3,
    maxRetries: 1,
    timeoutMs: 900000,
    repeatedPromptLimit: 2
  },
  metrics: {
    enabled: true,
    costRates: {
      claudeInputPerMTok: 3,
      claudeOutputPerMTok: 15,
      codexInputPerMTok: 1.25,
      codexOutputPerMTok: 10
    }
  },
  permissions: {
    sandboxMode: "workspace-write",
    approvalMode: "on-request",
    allowFileWrites: true,
    allowGitOperations: true,
    fullPower: false
  },
  prompting: {
    strategy: "concise"
  },
  output: {
    verbose: false,
    color: "auto"
  }
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base, override) {
  if (!isPlainObject(override)) {
    return base;
  }

  const next = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      next[key] = mergeConfig(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function resolveOrchestrationConfigFile(cwd) {
  for (const fileName of CONFIG_FILE_NAMES) {
    const candidate = path.join(cwd, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(cwd, CONFIG_FILE_NAMES[0]);
}

export function loadOrchestrationConfig(cwd) {
  const stateConfig = getConfig(cwd);
  const filePath = resolveOrchestrationConfigFile(cwd);
  const fileConfig = readJsonIfExists(filePath) ?? {};
  const orchestrationState = isPlainObject(stateConfig.orchestration) ? stateConfig.orchestration : {};

  return mergeConfig(
    mergeConfig(DEFAULT_ORCHESTRATION_CONFIG, fileConfig),
    orchestrationState
  );
}

export function summarizeOrchestrationConfig(config) {
  const providerIds = Object.keys(config.providers ?? {});
  return {
    defaultWorkflow: config.defaultWorkflow,
    routing: config.routing,
    providers: providerIds,
    timeoutMs: config.execution?.timeoutMs ?? 0,
    retries: config.execution?.retries ?? 0,
    parallelAgents: config.execution?.parallelAgents ?? [],
    allowConcurrentWrites: config.execution?.allowConcurrentWrites === true,
    currentMode: config.mode?.current ?? config.mode?.default ?? "balanced",
    sandboxMode: config.permissions?.sandboxMode ?? "workspace-write",
    approvalMode: config.permissions?.approvalMode ?? "on-request",
    allowFileWrites: config.permissions?.allowFileWrites !== false,
    allowGitOperations: config.permissions?.allowGitOperations !== false,
    promptStrategy: config.prompting?.strategy ?? "concise"
  };
}
