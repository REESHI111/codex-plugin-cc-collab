---
description: Run configured model agents in parallel and aggregate their outputs
argument-hint: '[--write] [--agents codex,codex-fast] [--model <model|spark>] [task ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a parallel multi-agent workflow through the collaborative runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" parallel "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
Do not paraphrase, summarize, or add commentary before or after it.
