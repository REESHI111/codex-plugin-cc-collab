---
description: Query and inspect the orchestration context graph
argument-hint: 'status|config|enable|disable|init [--install]|update|query|explain|path|context [args]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Query the collaborative runtime context graph.

Raw slash-command arguments:
`$ARGUMENTS`

Supported commands:
- `status`: show provider availability, graph path, node count, edge count, and provider health
- `config`: preview the recommended context graph config block
- `enable`: persist the recommended context graph config through the plugin state config
- `disable`: disable context graph prompt injection and memory retrieval without deleting graph files
- `init`: validate Graphify dependencies and build the first context graph
- `init --install`: explicitly allow the runtime to install missing Graphify Python dependencies with pip before building
- `update`: refresh the graph from the current workspace
- `query <text>`: retrieve a compact graph region for an architecture question
- `explain <node>`: inspect a matching graph node and its neighbors
- `path <source> <target>`: find the shortest graph path between two labels
- `context <task>`: retrieve task-scoped graph context for Claude/Codex prompting

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" graph "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is.
