# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews, task delegation, and collaborative Claude + Codex coding workflows.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:pair` for Claude architecture + Codex implementation + Claude review
- `/codex:codex-inline` for fast direct Codex implementation
- `/codex:debate` for Claude and Codex tradeoff comparison
- `/codex:parallel` for configurable multi-agent runs
- `/codex:graph` for Graphify-backed context graph queries and runtime memory status
- `/codex:mode` to switch between fast, balanced, and architect orchestration
- `/codex:rescue`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add REESHI111/codex-plugin-cc-collab
```

This only registers where Claude Code should look for the plugin. You must still install the plugin from that marketplace.

Install the plugin:

```bash
/plugin install codex@codex-collab
```

Reload plugins:

```bash
/reload-plugins
```

If Claude Code keeps loading an older cached version after reinstalling, run:

```bash
/codex:upgrade
/reload-plugins
/codex:ccv
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## First-Run Checklist

1. Add and install the plugin:

```bash
/plugin marketplace add REESHI111/codex-plugin-cc-collab
/plugin install codex@codex-collab
/reload-plugins
```

2. Verify Codex:

```bash
/codex:ccv
/codex:setup
```

3. Enable collaborative memory mode when you want Graphify context:

```bash
/codex:graph config
/codex:graph enable
/codex:graph init
/codex:graph status
```

4. If `/codex:graph init` reports missing Python dependencies, install Graphify's Python dependencies in the environment that runs Claude Code/Codex, then rerun:

```bash
python3 -m pip install graphifyy
/codex:graph init --force
```

You can also let the plugin run the dependency install explicitly:

```bash
/codex:graph init --install
```

5. Confirm the main collaborative commands:

```bash
/codex:mode balanced
/codex:codex-inline --read-only inspect the project structure
/codex:pair --read-only plan a small safe refactor
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex:pair`

Runs the collaborative pair-programming workflow:

1. Claude creates a concise architecture and implementation plan.
2. Codex executes the implementation through the existing app-server runtime.
3. Claude reviews the result and can request one refinement pass for blocking issues.
4. The final response is attributed by model.

Examples:

```bash
/codex:pair add optimistic updates to the task list
/codex:pair --model gpt-5.4-mini refactor the settings page into smaller components
/codex:pair --read-only plan the refactor without editing files
```

Use this when the task benefits from both architectural judgment and direct workspace edits.
Collaborative implementation commands default to safe write mode: `sandbox=workspace-write` and `approval=on-request`.

### `/codex:codex-inline`

Bypasses the heavier planning and review loop and sends the task straight to Codex.

Examples:

```bash
/codex:codex-inline generate the migration for the new audit table
/codex:codex-inline convert these tests from callbacks to async/await
/codex:codex-inline --read-only inspect where this component should live
```

Use this for boilerplate, repetitive edits, simple components, migrations, and narrow refactors.

### `/codex:debate`

Runs a read-only architecture debate:

1. Claude proposes a solution.
2. Codex proposes an alternative.
3. Claude compares tradeoffs and gives a final recommendation.

Examples:

```bash
/codex:debate should this cache live in Redis or Postgres?
/codex:debate compare server actions versus route handlers for this form flow
```

Use this before large refactors, framework decisions, optimization work, and architecture choices.

### `/codex:parallel`

Runs configured model agents simultaneously and aggregates their outputs. The default provider set includes Codex; additional providers can be described in config for future executors.

Examples:

```bash
/codex:parallel investigate the flaky checkout test
/codex:parallel --read-only --agents codex,codex-fast compare fixes for the API timeout
```

Use this when you want independent attempts or comparisons before choosing an implementation.
Only one writer is allowed by default. Multiple parallel writers are blocked unless you explicitly set `execution.allowConcurrentWrites=true`.

### `/codex:graph`

Queries the optional Graphify-backed context graph. This is the foundation for long-running architecture memory and selective context retrieval.

Examples:

```bash
/codex:graph status
/codex:graph config
/codex:graph enable
/codex:graph init
/codex:graph update
/codex:graph query auth flow
/codex:graph explain UserService
/codex:graph path UserService DatabasePool
/codex:graph context current checkout bug
```

Use this when Claude or Codex needs architecture context without flooding the prompt with the whole repository.
When enabled, collaborative workflows refresh the graph after reported file changes and save compact execution memory under `graphify-out/memory/orchestration/`.

### `/codex:ccv`

Shows the installed plugin version, repo/marketplace metadata, active plugin cache path, and Graphify availability.

Examples:

```bash
/codex:ccv
/codex:ccv --json
```

Use this after `/reload-plugins` to confirm Claude Code is running the expected plugin version and bundle.

### `/codex:upgrade`

Repairs the local Claude Code plugin installation when `/reload-plugins` keeps loading an older cache. It fetches the `codex-collab` marketplace clone, fast-forwards it, copies the latest `codex` plugin source into Claude's versioned cache, and updates `installed_plugins.json`.

Examples:

```bash
/codex:upgrade
/codex:upgrade --json
```

Use this when `/codex:ccv` shows an older plugin version than the GitHub marketplace version. Run `/reload-plugins` after it completes.

### `/codex:mode`

Switches the orchestration mode used by collaborative workflows.

Examples:

```bash
/codex:mode fast
/codex:mode balanced
/codex:mode architect
```

Modes:

- `fast`: minimal Claude review, speed first, Codex-heavy execution
- `balanced`: moderate orchestration and the default behavior
- `architect`: architecture-first planning and deeper review

### `/codex:status`

Shows running and recent Codex jobs plus runtime diagnostics for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running
- inspect sandbox, approvals, write access, executor availability, current workflow, and current mode
- inspect context graph provider availability, graph path, node count, and edge count

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

## Collaborative Architecture

The plugin preserves the official OpenAI structure:

- command markdown lives in `plugins/codex/commands`
- Codex app-server transport remains in `plugins/codex/scripts/lib/codex.mjs`
- job state, logs, cancellation, and result rendering continue to use the existing companion runtime

Collaborative features are added as extension layers:

- `plugins/codex/scripts/lib/orchestration/config.mjs` loads workflow configuration
- `plugins/codex/scripts/lib/orchestration/executors.mjs` defines the `ModelExecutor` abstraction plus `CodexExecutor` and command-side `ClaudeExecutor`
- `plugins/codex/scripts/lib/orchestration/prompts.mjs` contains configurable prompt strategies
- `plugins/codex/scripts/lib/orchestration/workflows.mjs` implements `pair`, `codex-inline`, `debate`, and `parallel`
- `plugins/codex/scripts/lib/orchestration/context-graph.mjs` defines the context graph provider adapter used for Graphify-backed project memory

`ModelExecutor` is intentionally provider-neutral. Future executors such as Gemini, OpenRouter, Ollama, DeepSeek, or local models can implement the same methods:

- `executeTask()`
- `streamResponse()`
- `getCapabilities()`
- `supportsTools()`
- `supportsLongContext()`

## Configuration

Add `codex-companion.config.json` at the workspace root, or `.codex-companion/config.json`, to override defaults:

```json
{
  "routing": {
    "planner": "claude",
    "implementer": "codex",
    "reviewer": "claude"
  },
  "providers": {
    "codex": {
      "type": "codex",
      "label": "Codex",
      "model": "gpt-5.4-mini",
      "effort": "medium"
    },
    "codex-fast": {
      "type": "codex",
      "label": "Codex Fast",
      "model": "gpt-5.3-codex-spark",
      "effort": "low"
    }
  },
  "execution": {
    "timeoutMs": 600000,
    "retries": 1,
    "parallelAgents": ["codex", "codex-fast"],
    "allowConcurrentWrites": false
  },
  "mode": {
    "default": "balanced",
    "current": "balanced"
  },
  "loopProtection": {
    "maxDepth": 4,
    "maxIterations": 3,
    "maxRetries": 1,
    "timeoutMs": 900000,
    "repeatedPromptLimit": 2
  },
  "metrics": {
    "enabled": true
  },
  "permissions": {
    "sandboxMode": "workspace-write",
    "approvalMode": "on-request",
    "allowFileWrites": true,
    "allowGitOperations": true,
    "fullPower": false
  },
  "contextGraph": {
    "enabled": false,
    "provider": "graphify",
    "outputDir": "graphify-out",
    "graphPath": "graphify-out/graph.json",
    "updateStrategy": "workflow-end",
    "updateTimeoutMs": 120000,
    "backgroundSync": true,
    "lockUpdates": true,
    "staleLockMs": 600000,
    "recordPendingUpdates": true,
    "queryTokenBudget": 2000,
    "queryDepth": 2,
    "injectIntoPrompts": true,
    "promptTokenBudget": 2000,
    "promptQueryDepth": 2,
    "tokenBudgetByMode": {
      "fast": 1200,
      "balanced": 2000,
      "architect": 4000
    },
    "queryDepthByMode": {
      "fast": 1,
      "balanced": 2,
      "architect": 3
    },
    "retrievalLimitsByMode": {
      "fast": {
        "seedLimit": 4,
        "nodeLimit": 18,
        "edgeLimit": 24,
        "detailNodeLimit": 6,
        "detailEdgeLimit": 10,
        "compressionMode": "high"
      },
      "balanced": {
        "seedLimit": 6,
        "nodeLimit": 32,
        "edgeLimit": 48,
        "detailNodeLimit": 12,
        "detailEdgeLimit": 24,
        "compressionMode": "moderate"
      },
      "architect": {
        "seedLimit": 10,
        "nodeLimit": 80,
        "edgeLimit": 120,
        "detailNodeLimit": 28,
        "detailEdgeLimit": 56,
        "compressionMode": "light"
      }
    },
    "adaptiveCompression": true,
    "memoryRetrieval": true,
    "maxMemoryEntries": 3,
    "memoryTokenBudget": 1000,
    "saveExecutionMemory": true
  },
  "prompting": {
    "strategy": "concise"
  }
}
```

Configuration is additive; omitting a field keeps the built-in default.

## Context Graph Memory

The context graph layer is optional and disabled by default for compatibility. Enable it when you want Graphify to act as the runtime's semantic project memory:

```json
{
  "contextGraph": {
    "enabled": true,
    "provider": "graphify",
    "graphPath": "graphify-out/graph.json",
    "updateStrategy": "workflow-end",
    "syncOnSessionEnd": true,
    "retrievalSeedLimit": 6,
    "retrievalNodeLimit": 32,
    "retrievalEdgeLimit": 48,
    "adaptiveCompression": true,
    "showRetrievalScores": true
  }
}
```

The adapter defaults to `python3 -m graphify`. In a development checkout it also adds local Graphify source folders such as `graphify-7` to `PYTHONPATH`; in an installed Claude plugin, install the published Python package with `python3 -m pip install graphifyy` or run `/codex:graph init --install`. The PyPI package is named `graphifyy`, while the Python module and CLI remain `graphify`. If your environment uses a different install, set `contextGraph.command`, `contextGraph.commandArgs`, or `contextGraph.pythonPath`.

Graphify runtime notes:

- Existing `graph.json` files can still be queried through the built-in JavaScript fallback even when Python graph dependencies are unavailable.
- Building or updating a graph requires Graphify's Python dependencies. Recommended install: `python3 -m pip install graphifyy`.
- `/codex:graph init` creates `graphify-out/` and `graphify-out/memory/orchestration/`, checks dependencies, and reports exactly what is missing.
- `/codex:graph init --install` explicitly allows the runtime to install the core Graphify package with pip before building.
- If you rely on the bundled Graphify source during development or marketplace publishing, keep `graphify-7/` committed and do not ignore it.
- `/codex:graph enable` changes plugin state only; it does not delete or rewrite existing graph files.
- `/codex:graph disable` turns off prompt injection and memory retrieval without removing `graphify-out`.

Current behavior:

- `/codex:graph status` reports provider availability and graph freshness
- `/codex:graph config` previews the recommended memory-mode config
- `/codex:graph enable` persists the recommended config through the plugin state config
- `/codex:graph disable` turns off prompt injection and memory retrieval without deleting graph files
- `/codex:graph init` validates Graphify dependencies and builds the first graph
- `/codex:graph update` refreshes the current workspace graph
- `/codex:graph query`, `explain`, and `path` retrieve compact graph context
- `/codex:graph context` combines graph relationships with relevant prior orchestration memory
- `/codex:graph stress [query]` runs repeated retrieval checks and reports latency, token overruns, failures, and stability
- collaborative prompts receive task-scoped graph context when `injectIntoPrompts` is enabled
- graph retrieval ranks seed nodes by task relevance, applies architecture-aware boosts, expands only bounded neighborhoods, and shows node scores/reasons when `showRetrievalScores=true`
- graph prompt injection uses mode-aware context budgets: fast mode compresses aggressively, balanced mode keeps moderate detail, and architect mode explores deeper graph neighborhoods
- collaborative workflows call the graph updater after Codex-reported file changes
- Claude Code session end detects git-visible changed files from any source and queues a background graph sync when `syncOnSessionEnd=true`
- graph updates use a lock file and pending-update manifest to avoid concurrent write collisions
- collaborative workflow graph updates run through a background sync worker by default
- execution summaries are saved as markdown memory entries when `saveExecutionMemory` is enabled

External edit behavior:

- Edits made through `/codex:pair`, `/codex:codex-inline`, and `/codex:parallel` trigger graph sync from workflow results.
- Edits made outside the plugin, such as Cursor, Claude direct file edits, terminal edits, or another agent, are detected at Claude Code `SessionEnd` through `git status --porcelain`.
- Session-end sync queues changed files and starts the existing background graph worker; it does not block shutdown on a full graph rebuild.
- Set `contextGraph.syncOnSessionEnd=false` to disable session-end detection.
- Set `contextGraph.sessionEndBackgroundSync=false` to run the session-end update inline instead of queueing it.
- For immediate freshness after external edits, run `/codex:graph update`.

This layer is adapter-based so future graph or memory providers can replace Graphify without rewriting the orchestration workflows.

Retrieval tuning:

- `retrievalSeedLimit` controls how many top-ranked graph nodes seed a task query.
- `retrievalNodeLimit` caps selected nodes after ranking and bounded expansion.
- `retrievalEdgeLimit` caps selected edges among chosen nodes.
- `tokenBudgetByMode` controls prompt context size per workflow mode.
- `queryDepthByMode` controls graph expansion depth per workflow mode.
- `retrievalLimitsByMode` controls mode-specific seed, node, edge, and detail limits.
- `adaptiveCompression` preserves priority nodes first, then compresses lower-priority nodes and edges into compact summaries.
- `showRetrievalScores` exposes score and reason metadata in graph context for debugging.
- Token budget still acts as a hard output guard, but compression happens before truncation so high-signal context is not lost first.

## Execution Metrics

Collaborative workflows render an execution metrics block at the end of each run. Exact provider token data is used when available; otherwise the runtime estimates token counts from prompt and output size.

```text
[SYSTEM] Execution Metrics

Workflow:
- pair

Mode:
- BALANCED

Claude:
- Input Tokens: 14211
- Output Tokens: 2201

Codex:
- Input Tokens: 8211
- Output Tokens: 5882

Runtime:
- 41s

Files Modified:
- 4

Commands Executed:
- 9

Estimated Cost:
- $0.31

[SYSTEM] Graph Context Metrics

Retrieved Nodes:
- 18

Retrieved Edges:
- 24

Compressed Context:
- 77%

Estimated Token Savings:
- 1380

Graph Hit Rate:
- 80%

Retrieval Usefulness:
- 86/100

Retrieval Confidence:
- HIGH

[SYSTEM] Execution Timeline

- graph-context-retrieval (23ms) - injected:yes, confidence:HIGH, nodes:18
```

Metrics currently track:

- Claude input and output tokens
- Codex input and output tokens
- runtime duration
- files modified
- shell commands executed
- estimated cost
- workflow and mode
- retrieved graph node and edge counts
- graph context compression percentage
- estimated token savings versus uncompressed graph output
- graph hit rate, retrieval usefulness score, and confidence
- graph retrieval timeline entries for debugging context injection behavior

Graph stress diagnostics:

```bash
/codex:graph stress auth client --iterations 20 --token-budget 1200 --mode fast
```

The stress diagnostic repeatedly exercises bounded retrieval and reports average latency, p95 latency, failures, token budget overruns, max retrieved nodes, and max estimated context tokens. Use it after large refactors, graph rebuilds, or provider changes to catch retrieval drift, token spikes, or slowdowns.

## Loop Protection

The orchestration runtime includes configurable guards for runaway workflows:

- maximum orchestration depth
- maximum workflow iterations
- retry caps
- timeout guards
- repeated prompt detection

If a guard triggers, the workflow stops with a clear `[SYSTEM] Loop protection triggered` diagnostic and preserves any result already captured by the job runtime.

## Permission Modes

The recommended collaborative default is safe write mode:

- `sandboxMode: "workspace-write"`
- `approvalMode: "on-request"`
- `allowFileWrites: true`

This lets Codex create and edit files in the workspace while still requiring approval for guarded or destructive operations.

Read-only mode is still available:

```json
{
  "permissions": {
    "sandboxMode": "read-only",
    "allowFileWrites": false
  }
}
```

Full power mode is available only by explicit opt-in:

```json
{
  "permissions": {
    "sandboxMode": "full-access",
    "approvalMode": "never",
    "allowFileWrites": true,
    "fullPower": true
  }
}
```

> [!WARNING]
> Full power mode disables sandbox restrictions. Use it only in trusted repositories and never enable it silently for other users.

Each Codex implementation run logs the current execution capability:

```text
[SYSTEM] Sandbox Mode: workspace-write
[SYSTEM] Approval Mode: on-request
[SYSTEM] Write Access: ENABLED
```

If Codex reports that it could not create or edit files because the sandbox is read-only or approvals are disabled, the orchestrator adds a permission diagnostic with the corrective action.

Troubleshooting:

- If file creation fails, confirm `sandboxMode` is `workspace-write`.
- If guarded commands fail, use `approvalMode: "on-request"`.
- If package installs are denied, keep the default and approve only the specific install command you trust.
- If git commands fail, check repository filesystem permissions and `allowGitOperations`.
- If multiple parallel agents need to edit files, prefer one writer and run the others with `--read-only`.

## Migration Notes

Existing commands continue to work. `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`, `/codex:result`, `/codex:cancel`, and `/codex:setup` keep their original transport and state model.

The new workflows are opt-in. Use `/codex:rescue` for the previous delegation style, `/codex:codex-inline` for fast direct Codex execution, and `/codex:pair` when you want Claude and Codex to collaborate iteratively.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## Implemented Feature Summary

This collaborative runtime now includes:

- Claude + Codex pair programming with `/codex:pair`
- fast direct Codex execution with `/codex:codex-inline`
- read-only architecture comparison with `/codex:debate`
- configurable multi-agent execution with `/codex:parallel`
- workflow modes through `/codex:mode fast|balanced|architect`
- token, cost, file-change, command, and runtime metrics
- safe default write permissions with workspace-write sandbox and on-request approvals
- loop protection, retry caps, timeout guards, and command sanitization
- runtime diagnostics through `/codex:status`
- Graphify-backed context graph commands through `/codex:graph`
- context graph bootstrap, config preview, enable, and disable commands
- task-scoped graph context injection into collaborative prompts
- relevance-ranked graph retrieval with bounded node/edge selection and visible retrieval reasons
- token-aware graph compression with fast/balanced/architect retrieval profiles
- graph context effectiveness analytics in execution metrics
- graph observability traces for context retrieval, prompt injection, and graph sync timing
- `/codex:graph stress` diagnostics for large-repo retrieval stability checks
- execution memory saved under `graphify-out/memory/orchestration/`
- `/codex:graph context` retrieval that combines graph relationships with prior workflow memory
- graph update locking, pending-update recovery, stale lock handling, and parallel write-conflict diagnostics
- non-blocking background graph sync for collaborative workflow completion
- non-blocking session-end graph sync for git-visible external edits from Claude, Cursor, terminal tools, or other agents
- dependency-free `graph.json` query fallback when Python Graphify dependencies are not installed

## Step 1-10 Verification Summary

Use this section to verify what was implemented across the architecture upgrade:

1. **Collaborative orchestration commands**  
   Added `/codex:pair`, `/codex:codex-inline`, `/codex:debate`, and `/codex:parallel` while preserving the existing plugin runtime.

2. **Executor abstraction and routing**  
   Added provider-neutral executor structure around Claude/Codex roles so future providers can be added without rewriting workflows.

3. **Permission and execution safety**  
   Added safe write defaults, permission diagnostics, full-power opt-in, and blocked-write recovery guidance.

4. **Metrics, modes, and loop protection**  
   Added token/cost/runtime/file/command metrics, `/codex:mode`, command sanitization, timeout/retry/depth guards, and `/codex:status` runtime diagnostics.

5. **Graphify architecture integration**  
   Added a modular Graphify context provider instead of tightly coupling orchestration logic to Graphify internals.

6. **Graph commands and context retrieval**  
   Added `/codex:graph status`, `query`, `explain`, `path`, and `context` with relevance-ranked, bounded graph output.

7. **Prompt-time graph context injection**  
   Collaborative prompts can now receive task-scoped graph context when `contextGraph.enabled=true`, with mode-aware budgets and adaptive compression to avoid token spam.

8. **Execution memory layer**  
   Workflow summaries are saved under `graphify-out/memory/orchestration/` and retrieved with graph context for future tasks. Execution metrics now also report graph retrieval effectiveness, token savings, hit rate, and usefulness score.

9. **Live synchronization safety**  
   Added graph update locking, pending-update recovery, stale lock handling, failed-update requeueing, parallel write-conflict diagnostics, workflow background sync, session-end sync for external edits, and graph sync timing traces.

10. **Bootstrap, config, and packaging hardening**  
    Added `/codex:graph config`, `enable`, `disable`, `init`, and `stress`; documented dependency checks, first-run flow, stress diagnostics, and final feature summary; updated plugin/package descriptions for the collaborative memory runtime.
