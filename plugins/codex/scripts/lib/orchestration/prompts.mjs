const STRATEGIES = {
  concise: {
    instruction:
      "Keep the answer concise, implementation-oriented, and free of duplicate rationale. Prefer exact file edits, commands run, and remaining risks.",
    review:
      "Review the result for correctness, maintainability, and missing verification. Return only actionable changes or a clear acceptance."
  },
  rigorous: {
    instruction:
      "Be explicit about invariants, edge cases, tests, and failure modes. Keep reasoning summarized and focus on changes that can be verified.",
    review:
      "Pressure-test the implementation against the plan, edge cases, tests, and architecture. Call out only material issues."
  },
  fast: {
    instruction:
      "Optimize for speed. Make the smallest safe implementation and avoid broad refactors.",
    review:
      "Do a short correctness pass and identify only blocking issues."
  }
};

export function resolvePromptStrategy(name) {
  return STRATEGIES[name] ?? STRATEGIES.concise;
}

function appendContextGraphSection(lines, contextGraphText) {
  const context = String(contextGraphText ?? "").trim();
  if (!context) {
    return;
  }
  lines.push(
    "",
    "Relevant context graph:",
    context,
    "",
    "Use this graph context as a retrieval aid. Verify against source files before making risky edits."
  );
}

export function buildCodexInlinePrompt({ task, strategyName = "fast", contextGraphText = "" }) {
  const strategy = resolvePromptStrategy(strategyName);
  const lines = [
    "You are Codex acting as an implementation specialist inside a Claude + Codex pair-programming workflow.",
    strategy.instruction,
    "Avoid destructive commands such as rm -rf, git reset --hard, git clean -fd, or sudo unless the user explicitly asked for them.",
    "",
    "Task:",
    task.trim()
  ];
  appendContextGraphSection(lines, contextGraphText);
  return lines.join("\n");
}

export function buildPairImplementationPrompt({ task, claudePlan, strategyName = "concise", contextGraphText = "" }) {
  const strategy = resolvePromptStrategy(strategyName);
  const lines = [
    "You are Codex, the implementation specialist in a collaborative Claude + Codex workflow.",
    "Claude has already produced the architecture and implementation plan. Follow it unless repository evidence shows a safer minimal adjustment.",
    strategy.instruction,
    "",
    "User task:",
    task.trim(),
    "",
    "Claude architecture plan:",
    claudePlan.trim(),
    "",
    "Execution requirements:",
    "- Implement the requested changes in the workspace when write access is enabled.",
    "- Avoid destructive commands such as rm -rf, git reset --hard, git clean -fd, or sudo unless the user explicitly asked for them.",
    "- Run targeted verification when practical.",
    "- Return a compact summary of changed files, checks run, and any follow-up needed."
  ];
  appendContextGraphSection(lines, contextGraphText);
  return lines.join("\n");
}

export function buildDebateAlternativePrompt({ task, claudeProposal, strategyName = "rigorous", contextGraphText = "" }) {
  const strategy = resolvePromptStrategy(strategyName);
  const lines = [
    "You are Codex proposing an alternative technical approach for a Claude + Codex debate.",
    "Do not edit files. Compare architecture, implementation risk, maintainability, and verification cost.",
    strategy.instruction,
    "",
    "Decision or task:",
    task.trim(),
    "",
    "Claude proposal:",
    claudeProposal.trim(),
    "",
    "Return:",
    "- Your alternative recommendation",
    "- Key tradeoffs versus Claude's proposal",
    "- When Claude's proposal is better",
    "- A final concise recommendation"
  ];
  appendContextGraphSection(lines, contextGraphText);
  return lines.join("\n");
}

export function buildParallelAgentPrompt({ task, agentLabel, strategyName = "concise", contextGraphText = "" }) {
  const strategy = resolvePromptStrategy(strategyName);
  const lines = [
    `You are ${agentLabel}, one participant in a parallel multi-agent coding workflow.`,
    "Work independently. Do not assume other agents will cover gaps.",
    strategy.instruction,
    "",
    "Task:",
    task.trim(),
    "",
    "Return your result with: approach, implementation notes or proposed patch, verification, and risks."
  ];
  appendContextGraphSection(lines, contextGraphText);
  return lines.join("\n");
}
