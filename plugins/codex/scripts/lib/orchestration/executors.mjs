import { runAppServerTurn } from "../codex.mjs";

export class ModelExecutor {
  constructor(config = {}) {
    this.config = config;
  }

  get id() {
    return this.config.id ?? "model";
  }

  get label() {
    return this.config.label ?? this.id;
  }

  getCapabilities() {
    return {
      tools: false,
      longContext: false,
      streaming: false,
      workspaceWrite: false
    };
  }

  supportsTools() {
    return Boolean(this.getCapabilities().tools);
  }

  supportsLongContext() {
    return Boolean(this.getCapabilities().longContext);
  }

  async executeTask() {
    throw new Error(`${this.label} executor does not implement executeTask().`);
  }

  async streamResponse(task, options = {}) {
    return this.executeTask(task, options);
  }
}

function timeoutError(label, timeoutMs) {
  return new Error(`${label} timed out after ${timeoutMs}ms.`);
}

async function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function runWithRetry(task, options = {}) {
  const retries = Math.max(0, Number(options.retries) || 0);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 0) {
        options.onProgress?.({
          message: `Retrying ${options.label ?? "model task"} (${attempt}/${retries}).`,
          phase: "retrying"
        });
      }
      return await withTimeout(task(attempt), Number(options.timeoutMs) || 0, options.label ?? "model task");
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        throw error;
      }
    }
  }
  throw lastError;
}

export class CodexExecutor extends ModelExecutor {
  getCapabilities() {
    return {
      tools: true,
      longContext: true,
      streaming: true,
      workspaceWrite: true
    };
  }

  async executeTask(task, options = {}) {
    const prompt = typeof task === "string" ? task : task.prompt;
    if (!prompt?.trim()) {
      throw new Error("CodexExecutor requires a prompt.");
    }

    const model = options.model ?? this.config.model ?? null;
    const effort = options.effort ?? this.config.effort ?? null;
    const write = Boolean(options.write);

    return runWithRetry(
      () =>
        runAppServerTurn(options.cwd, {
          prompt,
          model,
          effort,
          sandbox: write ? "workspace-write" : "read-only",
          onProgress: options.onProgress,
          persistThread: Boolean(options.persistThread),
          threadName: options.threadName ?? null
        }),
      {
        retries: options.retries,
        timeoutMs: options.timeoutMs,
        onProgress: options.onProgress,
        label: this.label
      }
    );
  }
}

export class ClaudeExecutor extends ModelExecutor {
  getCapabilities() {
    return {
      tools: true,
      longContext: true,
      streaming: true,
      workspaceWrite: true,
      commandSide: true
    };
  }

  async executeTask(task, options = {}) {
    const externalOutput = options.externalOutput ?? task?.externalOutput ?? "";
    if (!externalOutput.trim()) {
      return {
        status: 0,
        finalMessage:
          "Claude execution is handled by the slash-command wrapper. Pass Claude's plan, proposal, or review output into the orchestrator.",
        reasoningSummary: [],
        touchedFiles: []
      };
    }
    return {
      status: 0,
      finalMessage: externalOutput,
      reasoningSummary: [],
      touchedFiles: []
    };
  }
}

export function createExecutor(providerId, providerConfig = {}) {
  const type = providerConfig.type ?? providerId;
  const config = {
    id: providerId,
    ...providerConfig
  };

  switch (type) {
    case "codex":
      return new CodexExecutor(config);
    case "claude":
      return new ClaudeExecutor(config);
    default:
      return new ModelExecutor(config);
  }
}
