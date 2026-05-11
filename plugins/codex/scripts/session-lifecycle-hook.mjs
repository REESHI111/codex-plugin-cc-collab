#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { loadOrchestrationConfig } from "./lib/orchestration/config.mjs";
import { createContextGraphProvider } from "./lib/orchestration/context-graph.mjs";
import { runCommand } from "./lib/process.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(SCRIPT_DIR, "codex-companion.mjs");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

function parseGitStatusPorcelain(output) {
  const entries = String(output ?? "").split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) {
      continue;
    }
    if (status.includes("R") || status.includes("C")) {
      const target = entries[index + 1];
      if (target) {
        files.push(target);
        index += 1;
        continue;
      }
    }
    files.push(filePath);
  }
  return [...new Set(files)]
    .filter((filePath) => filePath && !filePath.startsWith("graphify-out/") && filePath !== "graphify-out");
}

function detectChangedFiles(cwd) {
  const result = runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 3000
  });
  if (result.error || result.status !== 0) {
    return [];
  }
  return parseGitStatusPorcelain(result.stdout);
}

async function syncContextGraphOnSessionEnd(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = loadOrchestrationConfig(workspaceRoot);
  if (config.contextGraph?.enabled !== true || config.contextGraph?.syncOnSessionEnd === false) {
    return;
  }
  const files = detectChangedFiles(workspaceRoot);
  if (files.length === 0) {
    return;
  }
  const provider = createContextGraphProvider({ cwd: workspaceRoot, config });
  const background = config.contextGraph?.sessionEndBackgroundSync !== false;
  if (background) {
    await provider.enqueueUpdate(files, {
      reason: "session-end",
      workerScriptPath: COMPANION_SCRIPT
    });
  } else {
    await provider.updateFiles(files, {
      reason: "session-end"
    });
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  await syncContextGraphOnSessionEnd(cwd);

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
