---
description: Run a deterministic programmable collaboration pipeline
argument-hint: '[pipeline or task]'
allowed-tools: Bash, AskUserQuestion
---

Run a lightweight programmable collaboration pipeline.

Default behavior:
- Claude creates/normalizes a compact planning artifact.
- Codex implements executable stages.
- Claude review is added only when the user requested it or escalation triggers require it.

Supported pipeline styles:

```text
codex>brainstorm
claude>analyze
codex>implement
claude>review
```

```text
brainstorm=codex analyze=claude implement=codex review=claude
```

```text
cu Codex brainstorms the idea, Claude analyzes architecture, Codex implements, Claude reviews.
```

Use only deterministic stage definitions. Do not create recursive agent swarms or ask the runtime to call `/codex:collab` again.

Raw slash-command arguments:
`$ARGUMENTS`

First, write a compact Claude collaboration brief to a temp file. The brief must include only:
- summary
- decisions
- todos
- architecture notes
- risks
- nextStageInput

Then run:

```bash
BRIEF_FILE="$(mktemp)"
cat > "$BRIEF_FILE" <<'EOF'
[compact Claude collaboration brief here]
EOF
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" collab --claude-brief-file "$BRIEF_FILE" "$ARGUMENTS"
rm -f "$BRIEF_FILE"
```

Return the command stdout verbatim, exactly as-is.
