---
description: Directly invoke Codex for a fast implementation task
argument-hint: '[--read-only|--full-power] [--model <model|spark>] [--effort none|minimal|low|medium|high|xhigh] [task ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a fast Codex implementation pass through the collaborative runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Use this for boilerplate, components, migrations, mechanical refactors, and other tasks where Claude does not need to plan or review first.
By default this runs in safe write mode: workspace-write sandbox with on-request approvals.
Use `--read-only` for analysis without edits.
Use `--full-power` only when the repository is trusted and unrestricted execution is explicitly required.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" codex-inline "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
Do not paraphrase, summarize, or add commentary before or after it.
