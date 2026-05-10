import test from "node:test";
import assert from "node:assert/strict";

import { createLoopGuard } from "../plugins/codex/scripts/lib/orchestration/loop-protection.mjs";
import { createMetricsCollector, renderExecutionMetrics } from "../plugins/codex/scripts/lib/orchestration/metrics.mjs";
import { normalizeWorkflowMode, resolveWorkflowMode } from "../plugins/codex/scripts/lib/orchestration/modes.mjs";
import { sanitizeCommandPrompt } from "../plugins/codex/scripts/lib/orchestration/sanitizer.mjs";

test("sanitizer strips duplicated slash-command prefixes while preserving prompt content", () => {
  assert.equal(
    sanitizeCommandPrompt("/codex:codex-inline /codex:codex-inline create server").text,
    "create server"
  );
  assert.equal(
    sanitizeCommandPrompt("  codex-inline   pair   add route\nand tests").text,
    "add route\nand tests"
  );
  assert.equal(
    sanitizeCommandPrompt("\"/codex:codex-inline\" should remain quoted").text,
    "\"/codex:codex-inline\" should remain quoted"
  );
});

test("metrics collector estimates usage and renders execution metrics", () => {
  const metrics = createMetricsCollector({ mode: { current: "fast" } });
  metrics.startExecution({ workflow: "pair", mode: "fast" });
  metrics.trackModelUsage("claude", { inputText: "plan input", outputText: "plan output" });
  metrics.trackModelUsage("codex", { inputTokens: 100, outputTokens: 50 });
  metrics.trackShellCommand("npm test");
  metrics.trackFileChange("README.md");
  const finalMetrics = metrics.finishExecution();
  const rendered = renderExecutionMetrics(finalMetrics);

  assert.equal(finalMetrics.workflow, "pair");
  assert.equal(finalMetrics.mode, "fast");
  assert.equal(finalMetrics.commandsExecutedCount, 1);
  assert.equal(finalMetrics.filesModifiedCount, 1);
  assert.match(rendered, /\[SYSTEM\] Execution Metrics/);
  assert.match(rendered, /Workflow:\n- pair/);
  assert.match(rendered, /Mode:\n- FAST/);
});

test("workflow modes normalize and reject unsupported values", () => {
  assert.equal(normalizeWorkflowMode("architect"), "architect");
  assert.equal(resolveWorkflowMode({ mode: { current: "fast" } }).label, "FAST");
  assert.throws(() => normalizeWorkflowMode("turbo"), /Unsupported workflow mode/);
});

test("loop guard blocks repeated prompts and excessive depth", () => {
  const guard = createLoopGuard({ loopProtection: { repeatedPromptLimit: 1 } });
  guard.trackPrompt("same prompt");
  assert.throws(() => guard.trackPrompt("same   prompt"), /Repeated execution prompt detected/);

  const deepGuard = createLoopGuard({ loopProtection: { maxDepth: 1 } }, { depth: 2 });
  assert.throws(() => deepGuard.assertCanStart("pair"), /Maximum orchestration depth exceeded/);
});
