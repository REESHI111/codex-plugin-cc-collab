---
description: Fetch and install the latest codex-collab plugin cache, then report reload steps
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" upgrade "$ARGUMENTS"`

Return the command stdout verbatim. This command repairs the common case where `/reload-plugins` reloads an older cache because the marketplace clone or `installed_plugins.json` was stale.
