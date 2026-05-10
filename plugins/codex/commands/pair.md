---
description: Pair Claude architecture and review with Codex implementation
argument-hint: '[--write] [--model <model|spark>] [--effort none|minimal|low|medium|high|xhigh] [task ...]'
allowed-tools: Read, Glob, Grep, Bash
---

Run a collaborative Claude + Codex coding workflow.

Raw slash-command arguments:
`$ARGUMENTS`

Workflow:
1. Claude analyzes the task architecturally and writes a concise implementation plan.
2. Codex implements the plan through `codex-companion.mjs pair`.
3. Claude reviews the Codex output for correctness, missing verification, and architecture drift.
4. If the review finds a blocking issue that Codex should fix immediately, run one refinement pass by invoking `pair` again with the review appended to the plan.
5. Return the final merged result with clear model attribution.

Claude planning rules:
- Keep the plan concise and actionable.
- Do not implement code yourself before Codex runs unless Codex fails to start.
- Do not duplicate long reasoning in the final answer.
- Prefer `--write` when the user wants changes applied.

Execution pattern:

```bash
PLAN_FILE="$(mktemp)"
# write Claude's plan into "$PLAN_FILE"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" pair --claude-plan-file "$PLAN_FILE" "$ARGUMENTS"
rm -f "$PLAN_FILE"
```

Final response:
- Include `[CLAUDE]` for the plan/review portions and `[CODEX]` for Codex's implementation result.
- Include commands/checks run when Codex reports them.
- If a refinement pass ran, say so and report the final pass only unless the first pass contains important context.
