---
description: Show the installed Codex collab plugin version, cache path, and Graphify availability
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ccv "$ARGUMENTS"`

Return the command stdout verbatim. This command is used to verify whether Claude Code reloaded the expected plugin version and whether the installed plugin bundle contains Graphify.
