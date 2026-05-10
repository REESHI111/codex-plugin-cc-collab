---
description: Set or show the collaborative workflow execution mode
argument-hint: '[fast|architect|balanced]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Set or show the current Codex collaborative orchestration mode.

Modes:
- `fast`: minimal Claude review, Codex-heavy execution, speed first
- `architect`: architecture-first planning and deeper review
- `balanced`: moderate orchestration and the default behavior

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" mode "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
