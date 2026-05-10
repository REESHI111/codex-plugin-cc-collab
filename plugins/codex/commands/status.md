---
description: Show active and recent Codex jobs plus runtime diagnostics for this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the runtime diagnostics block and a compact Markdown table for current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose beyond the diagnostics and job table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.
- Preserve the runtime diagnostics block, including sandbox, approvals, write access, executor status, workflow, and mode.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
