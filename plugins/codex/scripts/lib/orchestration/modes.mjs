export const WORKFLOW_MODES = {
  fast: {
    id: "fast",
    label: "FAST",
    promptStrategy: "fast",
    reviewDepth: "minimal",
    codexFirst: true
  },
  balanced: {
    id: "balanced",
    label: "BALANCED",
    promptStrategy: "concise",
    reviewDepth: "moderate",
    codexFirst: false
  },
  architect: {
    id: "architect",
    label: "ARCHITECT",
    promptStrategy: "rigorous",
    reviewDepth: "deep",
    codexFirst: false
  }
};

export function normalizeWorkflowMode(value, fallback = "balanced") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!WORKFLOW_MODES[normalized]) {
    throw new Error(`Unsupported workflow mode "${value}". Use fast, architect, or balanced.`);
  }
  return normalized;
}

export function resolveWorkflowMode(config = {}, override = null) {
  const modeId = normalizeWorkflowMode(override ?? config.mode?.current ?? config.mode?.default ?? "balanced");
  return WORKFLOW_MODES[modeId];
}

export function applyWorkflowMode(config = {}, mode) {
  const resolved = resolveWorkflowMode(config, mode);
  return {
    ...config,
    mode: {
      ...(config.mode ?? {}),
      current: resolved.id
    },
    prompting: {
      ...(config.prompting ?? {}),
      strategy: config.prompting?.strategy ?? resolved.promptStrategy
    }
  };
}
