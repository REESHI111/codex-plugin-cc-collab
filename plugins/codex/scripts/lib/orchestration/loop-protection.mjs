import { createHash } from "node:crypto";

const DEFAULT_LIMITS = {
  maxDepth: 4,
  maxIterations: 3,
  maxRetries: 1,
  timeoutMs: 900000,
  repeatedPromptLimit: 2
};

function hashText(value) {
  return createHash("sha256").update(String(value ?? "").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export function resolveLoopLimits(config = {}) {
  return {
    ...DEFAULT_LIMITS,
    ...(config.loopProtection ?? {})
  };
}

export function createLoopGuard(config = {}, options = {}) {
  const limits = resolveLoopLimits(config);
  const depth = Number(options.depth ?? process.env.CODEX_ORCHESTRATION_DEPTH ?? 0) || 0;
  const promptCounts = new Map();
  let iterations = 0;
  const startedAt = Date.now();

  function fail(reason) {
    const error = new Error(`[SYSTEM]\nLoop protection triggered:\n${reason}`);
    error.loopProtection = true;
    throw error;
  }

  return {
    limits,
    depth,
    assertCanStart(workflow) {
      if (depth > limits.maxDepth) {
        fail(`Maximum orchestration depth exceeded for ${workflow}.`);
      }
    },
    trackIteration(label = "iteration") {
      iterations += 1;
      if (iterations > limits.maxIterations) {
        fail(`Maximum ${label} count exceeded (${limits.maxIterations}).`);
      }
    },
    trackPrompt(prompt) {
      const key = hashText(prompt);
      const next = (promptCounts.get(key) ?? 0) + 1;
      promptCounts.set(key, next);
      if (next > limits.repeatedPromptLimit) {
        fail("Repeated execution prompt detected.");
      }
    },
    assertWithinTimeout() {
      const elapsed = Date.now() - startedAt;
      if (limits.timeoutMs > 0 && elapsed > limits.timeoutMs) {
        fail(`Workflow timeout exceeded (${limits.timeoutMs}ms).`);
      }
    },
    childEnv(env = process.env) {
      return {
        ...env,
        CODEX_ORCHESTRATION_DEPTH: String(depth + 1)
      };
    }
  };
}
