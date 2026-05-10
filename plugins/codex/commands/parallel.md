---
description: Run configured model agents in parallel and aggregate their outputs
argument-hint: '[--read-only|--full-power] [--agents codex,codex-fast] [--model <model|spark>] [task ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a parallel multi-agent workflow through the collaborative runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Default behavior permits one writing agent in safe write mode.
When multiple agents are selected, prefer `--read-only` to avoid conflicting edits.
Unrestricted full power mode requires explicit `--full-power` or config opt-in.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" parallel "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
Do not paraphrase, summarize, or add commentary before or after it.
