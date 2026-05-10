---
description: Compare a Claude proposal against a Codex alternative before choosing an approach
argument-hint: '[--model <model|spark>] [--effort none|minimal|low|medium|high|xhigh] [decision or task ...]'
allowed-tools: Read, Glob, Grep, Bash
---

Run a Claude + Codex debate workflow for architecture and implementation decisions.

Raw slash-command arguments:
`$ARGUMENTS`

Workflow:
1. Claude proposes a solution with key assumptions and tradeoffs.
2. Codex proposes an alternative through `codex-companion.mjs debate`.
3. Claude compares both positions and returns a final recommendation.

Execution pattern:

```bash
PROPOSAL_FILE="$(mktemp)"
# write Claude's proposal into "$PROPOSAL_FILE"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" debate --claude-proposal-file "$PROPOSAL_FILE" "$ARGUMENTS"
rm -f "$PROPOSAL_FILE"
```

Rules:
- Do not edit files during debate mode.
- Keep the final answer concise: `[CLAUDE] Proposal`, `[CODEX] Alternative`, `[CLAUDE] Recommendation`.
- Prefer a concrete decision over an open-ended comparison.
