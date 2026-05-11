const PROVIDER_ALIASES = {
  claude: "claude",
  anthropic: "claude",
  codex: "codex",
  openai: "codex",
  gemini: "gemini",
  google: "gemini",
  ollama: "ollama",
  local: "ollama",
  openrouter: "openrouter",
  deepseek: "deepseek"
};

const ROLE_ALIASES = {
  brainstorm: "brainstorm",
  brainstorms: "brainstorm",
  ideate: "brainstorm",
  analyze: "analyze",
  analyzes: "analyze",
  analyse: "analyze",
  architecture: "analyze",
  architect: "analyze",
  plan: "plan",
  plans: "plan",
  implement: "implement",
  implements: "implement",
  code: "implement",
  codes: "implement",
  build: "implement",
  builds: "implement",
  refactor: "refactor",
  refactors: "refactor",
  migrate: "migrate",
  migrates: "migrate",
  review: "review",
  reviews: "review",
  verify: "verify",
  verifies: "verify",
  test: "verify",
  tests: "verify",
  summarize: "summarize",
  summarise: "summarize"
};

const IMPLEMENTATION_ROLES = new Set(["implement", "implement-frontend", "implement-backend", "refactor", "migrate"]);
const CLAUDE_ROLES = new Set(["brainstorm", "analyze", "plan", "review", "verify", "summarize"]);
const RECURSIVE_TOKENS = /\b(codex:collab|\/collab|\/codex:pair|\/codex:parallel|run\s+collab|spawn\s+agents?)\b/i;
const IMPLEMENT_QUALIFIERS = new Set(["frontend", "backend", "ui", "api", "server", "database", "db"]);

function compactWhitespace(text) {
  return String(text ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizePipelineInput(text) {
  return compactWhitespace(String(text ?? "")
    .replace(/\r/g, "\n")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/`/g, ""))
    .slice(0, 12000));
}

function providerId(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

function roleId(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .trim()
    .replace(/\s+/g, "-");
  const [head, ...tail] = normalized.split("-");
  const canonical = ROLE_ALIASES[head] ?? head;
  const qualifier = tail.find((part) => IMPLEMENT_QUALIFIERS.has(part));
  if (canonical === "implement" && qualifier) {
    return `implement-${qualifier === "db" ? "database" : qualifier}`;
  }
  return canonical;
}

function splitRolePhrase(value) {
  const words = compactWhitespace(value).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return { role: "", residual: "" };
  }
  const canonical = ROLE_ALIASES[String(words[0]).toLowerCase().replace(/[^a-z0-9_-]/g, "")] ?? words[0];
  const roleWords = [words[0]];
  let residualStart = 1;
  if (canonical === "implement") {
    const qualifierIndex = words.slice(1, 4).findIndex((word) =>
      IMPLEMENT_QUALIFIERS.has(String(word).toLowerCase().replace(/[^a-z0-9_-]/g, ""))
    );
    if (qualifierIndex >= 0) {
      roleWords.push(words[qualifierIndex + 1]);
      residualStart = qualifierIndex + 2;
    }
  }
  return {
    role: roleId(roleWords.join(" ")),
    residual: words.slice(residualStart).join(" ")
  };
}

function isStageRole(role) {
  return CLAUDE_ROLES.has(role) || IMPLEMENTATION_ROLES.has(role) || role.startsWith("implement-");
}

function parseStructuredLines(text) {
  const stages = [];
  const residual = [];
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    const matches = [...trimmed.matchAll(/([a-zA-Z][\w-]*)\s*>\s*([^>\n]+?)(?=\s+[a-zA-Z][\w-]*\s*>|$)/g)];
    if (!matches.length) {
      if (trimmed) residual.push(trimmed);
      continue;
    }
    let lineResidual = trimmed;
    for (const match of matches) {
      const { role, residual: roleResidual } = splitRolePhrase(match[2]);
      stages.push({
        provider: providerId(match[1]),
        role,
        source: "structured"
      });
      lineResidual = lineResidual.replace(match[0], roleResidual ? ` ${roleResidual} ` : " ");
    }
    const remainder = compactWhitespace(lineResidual);
    if (remainder) residual.push(remainder);
  }
  return { stages, residual };
}

function parseInlineAssignments(text) {
  const stages = [];
  const consumed = [];
  const assignmentPattern = /\b([a-zA-Z][\w-]*)\s*=\s*([a-zA-Z][\w-]*)\b/g;
  let match;
  while ((match = assignmentPattern.exec(text)) !== null) {
    stages.push({
      provider: providerId(match[2]),
      role: roleId(match[1]),
      source: "inline"
    });
    consumed.push(match[0]);
  }
  let residual = text;
  for (const item of consumed) {
    residual = residual.replace(item, " ");
  }
  return { stages, residual: compactWhitespace(residual).split(/\n/).filter(Boolean) };
}

function parseNaturalLanguage(text) {
  const stages = [];
  const cleaned = text.replace(/^cu\b/i, "").replace(/^custom\b/i, "");
  for (const segment of cleaned.split(/[,\n;.]+/)) {
    const match = segment.trim().match(/\b(claude|codex|gemini|ollama|openrouter|deepseek)\b\s+(.+)/i);
    if (!match) continue;
    const provider = providerId(match[1]);
    const words = match[2].trim().split(/\s+/).slice(0, 4).join(" ");
    stages.push({
      provider,
      role: splitRolePhrase(words).role,
      source: "natural"
    });
  }
  return { stages, residual: [cleaned.replace(/\b(claude|codex|gemini|ollama|openrouter|deepseek)\b[^,;.]+[,;.]?/gi, " ").trim()].filter(Boolean) };
}

function validatePipeline(stages, config = {}) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error("Collaboration pipeline must contain at least one stage.");
  }
  const maxStages = Number(config.collab?.maxStages ?? 8) || 8;
  if (stages.length > maxStages) {
    throw new Error(`Collaboration pipeline is too large. Use ${maxStages} stages or fewer.`);
  }
  const providers = config.providers ?? {};
  const errors = [];
  stages.forEach((stage, index) => {
    if (!providers[stage.provider]) {
      errors.push(`Stage ${index + 1} uses unknown provider "${stage.provider}". Add it to codex-companion.config.json first.`);
    }
    if (!isStageRole(stage.role)) {
      errors.push(`Stage ${index + 1} has unsupported role "${stage.role}".`);
    }
    if (RECURSIVE_TOKENS.test(`${stage.provider} ${stage.role}`)) {
      errors.push(`Stage ${index + 1} appears recursive and was rejected.`);
    }
  });
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
}

export function getProviderCapabilityRegistry(config = {}) {
  const defaults = {
    claude: {
      strengths: ["architecture", "reasoning", "review", "escalation"],
      roles: ["brainstorm", "analyze", "plan", "review", "verify", "summarize"],
      tools: true,
      workspaceWrite: false,
      longContext: true
    },
    codex: {
      strengths: ["implementation", "execution", "refactors", "repetitive generation"],
      roles: ["brainstorm", "implement", "implement-frontend", "implement-backend", "refactor", "migrate", "verify"],
      tools: true,
      workspaceWrite: true,
      longContext: true
    },
    gemini: {
      strengths: ["frontend", "multimodal", "ui generation"],
      roles: ["brainstorm", "analyze", "implement-frontend", "review"],
      tools: false,
      workspaceWrite: false,
      longContext: true
    }
  };
  const registry = {};
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    registry[id] = {
      provider: id,
      label: provider.label ?? id,
      type: provider.type ?? id,
      ...(defaults[provider.type ?? id] ?? {
        strengths: provider.strengths ?? [],
        roles: provider.roles ?? ["brainstorm", "analyze", "review"],
        tools: false,
        workspaceWrite: false,
        longContext: false
      }),
      ...(provider.capabilities ?? {})
    };
  }
  return registry;
}

export function parseCollabPipeline(input, config = {}) {
  const sanitized = sanitizePipelineInput(input);
  if (RECURSIVE_TOKENS.test(sanitized)) {
    throw new Error("Collaboration request contains recursive orchestration instructions and was rejected.");
  }

  let parsed = parseStructuredLines(sanitized);
  if (parsed.stages.length === 0) {
    parsed = parseInlineAssignments(sanitized);
  }
  if (parsed.stages.length === 0 && /\b(claude|codex|gemini|ollama|openrouter|deepseek)\b/i.test(sanitized)) {
    parsed = parseNaturalLanguage(sanitized);
  }

  const stages = parsed.stages.length
    ? parsed.stages.map((stage, index) => ({ ...stage, id: `stage-${index + 1}` }))
    : [
        { id: "stage-1", provider: "claude", role: "plan", source: "default" },
        { id: "stage-2", provider: "codex", role: "implement", source: "default" }
      ];
  validatePipeline(stages, config);

  const residual = compactWhitespace(parsed.residual?.join("\n") ?? "");
  const task = residual || sanitized.replace(/\b[a-zA-Z][\w-]*\s*=\s*[a-zA-Z][\w-]*\b/g, " ").trim();
  return {
    sanitized,
    task: compactWhitespace(task),
    stages,
    registry: getProviderCapabilityRegistry(config)
  };
}

export function pipelineDiagram(stages = []) {
  return stages.map((stage) => `${stage.provider}:${stage.role}`).join(" -> ");
}

export function buildStageArtifact({ stage, output = "", previousArtifacts = [], task = "" } = {}) {
  const body = compactWhitespace(output) || `Stage ${stage?.role ?? "stage"} completed.`;
  const decisions = body
    .split(/\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => /\b(decide|use|choose|selected|prefer|architecture|risk|todo|implement|change)\b/i.test(line))
    .slice(0, 6);
  const todos = body
    .split(/\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => /\b(todo|next|follow|remaining|verify|test)\b/i.test(line))
    .slice(0, 6);
  const risks = body
    .split(/\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => /\b(risk|warning|blocker|security|migration|breaking|failed)\b/i.test(line))
    .slice(0, 6);
  return {
    provider: stage?.provider ?? "unknown",
    role: stage?.role ?? "stage",
    summary: body.split(/\n/).find(Boolean)?.slice(0, 500) ?? "",
    decisions,
    todos,
    architecture: decisions.join("\n"),
    risks,
    nextStageInput: [
      `Task: ${task}`,
      previousArtifacts.length ? `Prior stage summaries:\n${previousArtifacts.map((artifact) => `- ${artifact.provider}:${artifact.role} ${artifact.summary}`).join("\n")}` : "",
      `Current stage summary: ${body.slice(0, 1500)}`
    ].filter(Boolean).join("\n\n")
  };
}

export function shouldEscalateCollab({ stageResults = [], metrics = {}, config = {} } = {}) {
  const riskPatterns = config.collab?.escalationFilePatterns ?? [
    /auth/i,
    /security/i,
    /permission/i,
    /migration/i,
    /database|db/i,
    /config/i,
    /package\.json/i
  ];
  const touchedFiles = stageResults.flatMap((stage) => stage.result?.touchedFiles ?? []);
  const commandFailures = stageResults
    .flatMap((stage) => stage.result?.commandExecutions ?? [])
    .filter((command) => Number(command.exitCode ?? command.status ?? 0) !== 0);
  const reasons = [];
  if (touchedFiles.length >= Number(config.collab?.largeRefactorFileThreshold ?? 8)) {
    reasons.push(`large change set (${touchedFiles.length} files)`);
  }
  if (touchedFiles.some((file) => riskPatterns.some((pattern) => pattern.test(String(file))))) {
    reasons.push("risk-sensitive files changed");
  }
  if (commandFailures.length) {
    reasons.push("verification command failure");
  }
  if (stageResults.some((stage) => stage.result?.permissionIssue)) {
    reasons.push("permission issue detected");
  }
  if ((metrics.graphContext?.highestConfidence ?? "NONE") === "LOW") {
    reasons.push("low graph retrieval confidence");
  }
  return {
    escalate: reasons.length > 0,
    reasons
  };
}
