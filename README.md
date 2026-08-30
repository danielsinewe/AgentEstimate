<p align="center">
  <img src="plugins/agent-eta/assets/logo.svg" alt="Agent ETA" width="520" />
</p>

# Agent ETA

**Know before you delegate.** Agent ETA gives Codex and Claude Code tasks an honest time range, explains what is driving it, and learns from completed runs without sending prompts or source code to an analytics service.

[Try the web estimator](https://agentestimate.vercel.app) · [Read the methodology](docs/research.md) · [View the source](https://github.com/danielsinewe/AgentEstimate)

> Agent ETA is a planning forecast, not a deadline, progress bar, or correctness guarantee. It predicts when the agent is likely to return control.

## What you get

- **About** — the modeled midpoint: about half of comparable runs should finish sooner.
- **Allow up to** — a practical planning bound: about four in five should finish sooner once your history supports that coverage.
- **A stage forecast** — Orient → Reason → Change → Verify → Deliver.
- **Explainable drivers** — ranked by marginal minutes, including scope, ambiguity, verification loops, deployment, and a deliberately weak repository-size prior.
- **Personal calibration** — similar local runs correct the center and upper quantiles without double-counting overlapping cohorts or learning from implausible stop boundaries.

## Choose a surface

| Surface | Best for | Persists raw prompts or code? |
| --- | --- | --- |
| [Web](https://agentestimate.vercel.app) | A quick visual estimate and browser-local calibration | No |
| CLI | Scripts, terminals, and JSON output | No |
| MCP | Letting Codex or Claude Code request an estimate | No |
| Plugin + hooks | Automatic forecasts and calibration at task boundaries | No |
| `@agent-eta/core` | Embedding the deterministic engine in another product | Never; the package has no I/O |

## Quick start

The hosted estimator needs no account:

**[Open Agent ETA →](https://agentestimate.vercel.app)**

To run every surface from source, use Node.js 24 or newer:

```bash
git clone https://github.com/danielsinewe/AgentEstimate.git
cd AgentEstimate
npm ci
npm run build
```

### CLI

```bash
node packages/integration/dist/cli.mjs estimate \
  "Add passkey login, verify it in the browser, and deploy it" \
  --provider codex \
  --model gpt-5.6-sol \
  --effort high \
  --speed standard
```

Read private prompts from stdin if you do not want them in shell history:

```bash
node packages/integration/dist/cli.mjs estimate \
  --provider claude \
  --model sonnet \
  --effort high \
  --cwd "$PWD" < task.txt
```

Useful local status commands:

```bash
node packages/integration/dist/cli.mjs calibrate
node packages/integration/dist/cli.mjs history --limit 20
node packages/integration/dist/cli.mjs estimate "Audit auth" --json
```

Historical JSONL import exists for experiments, but provider transcript formats are not stable APIs:

```bash
node packages/integration/dist/cli.mjs history-import /path/to/history.jsonl --provider auto
```

### MCP

Register the built stdio server with Codex:

```bash
codex mcp add agent-eta -- node "$PWD/packages/integration/dist/mcp.mjs"
```

Or with Claude Code:

```bash
claude mcp add --scope user agent-eta -- node "$PWD/packages/integration/dist/mcp.mjs"
```

The server exposes three read-only tools:

- `estimate_task` returns the range, stages, input clarity, spread, and top drivers.
- `current_run` reads the latest non-stale hook-tracked run for a repository.
- `calibration_status` reports sample counts, median error, and observed midpoint and planning-bound coverage.

MCP is excellent for asking for an estimate. Hooks are what make run capture automatic; an agent can otherwise choose not to call an MCP tool.

### Plugin + hooks

The build copies the runtime into the self-contained plugin bundle. Load it for a local session with:

```bash
claude --plugin-dir "$PWD/plugins/agent-eta"
```

Then send any prompt. The bundled skill, MCP server, and lifecycle hooks work together: the prompt-submit hook computes the return-time range, then gives the agent a privacy-safe developer instruction to show one short line—`⏱ About … · allow up to …`—before any other reply or tool call. If estimation fails, Agent ETA says so visibly and lets the prompt continue. Completion hooks record elapsed outcomes for local calibration.

After installing or updating the plugin, start a new session, open `/hooks`, and trust the reviewed Agent ETA hooks. Codex records trust against the exact hook version, so updates require one fresh review. Then send `Reply only OK`; the first line should begin with `⏱ About`. That canary verifies the plugin, hook, and first-response behavior together. If it only says `OK`, the hook is not active. `AGENTS.md`, `CLAUDE.md`, memory, skills, and MCP alone cannot provide the same lifecycle guarantee.

For workflows that must never start without a forecast, launch Codex or Claude Code with strict mode enabled:

```bash
AGENT_ETA_STRICT=1 codex
AGENT_ETA_STRICT=1 claude
```

Strict mode blocks only when Agent ETA cannot calculate a forecast. Normal mode remains fail-visible and continues the prompt.

The bundle also contains a Codex plugin manifest for personal or team marketplaces. This repository intentionally remains an application repository rather than a marketplace registry; the manual MCP setup above is the checkout-agnostic Codex path.

### Library

```ts
import { estimateTask } from '@agent-eta/core';

const forecast = estimateTask({
  prompt: 'Add a settings form and verify it in the browser.',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  repo: { fileCount: 420, linesOfCode: 82_000, testFileCount: 34 },
});

console.log(forecast.formatted.p50, forecast.formatted.p80);
```

The core is deterministic for the same input, seed, and calibration samples. It performs no filesystem, database, telemetry, or network operations.

## How the forecast works

Agent ETA is an explainable reference-class model, not an opaque claim of machine-learning precision.

1. It classifies the task and separates bounded micro-edits from vague product-level work.
2. It estimates five stages separately: Orient, Reason, Change, Verify, and Deliver.
3. It applies provider/model, effort, and speed interactions. Fast mode only compresses model-bound work; tests and deployments do not magically run faster.
4. It adds a capped logarithmic repository prior. Repository size can lengthen orientation, but it cannot dominate the task itself.
5. It prices interactions between sequential test, browser, service, and deployment loops.
6. It runs 1,600 deterministic correlated simulations with an explicit rework-tail state and reports P25, P50, P80, P95, and the mean.
7. Similar local outcomes contribute once through a robust similarity weight; enough history can correct P80/P95 coverage separately from the median.

The full rationale, source review, equations, and known limitations are in [docs/research.md](docs/research.md).

## Privacy

Raw prompts are processed in memory and are not copied into Agent ETA history. Source files are only sampled locally to derive aggregate repository measurements; file contents are not persisted. Stored runs contain:

- provider, normalized model, effort, and speed;
- derived prompt counts and categories, never prompt fragments;
- aggregate repository metrics, never paths or source text;
- forecast quantiles, timestamps, elapsed duration, and outcome;
- install-salted identifiers for runs, sessions, and repositories.

The web app stores derived calibration samples in that browser's `localStorage` and includes a reset control. The CLI/plugin store defaults to `~/.agent-eta/runs.jsonl`, or `$XDG_DATA_HOME/agent-eta/runs.jsonl` when configured. Codex/Claude plugin data directories override that location; an explicit `AGENT_ETA_DATA_DIR` takes highest priority. On supported systems the directory is created with mode `0700` and the files with mode `0600`.

Hook payloads do not consistently expose the active model, effort, or speed setting. Agent ETA uses any values the host supplies and keeps fallback configuration out of the short user-facing forecast. For exact passive forecasts, set `AGENT_ETA_MODEL`, `AGENT_ETA_EFFORT`, and `AGENT_ETA_SPEED` (`standard` or `fast`) in the environment that launches Codex or Claude Code; `AGENT_ETA_PROVIDER` can be set to `codex` or `claude` when host detection is unavailable. `AGENT_ETA_STRICT=1` blocks a prompt only when no forecast can be produced.

There is no product telemetry in the estimator, core engine, CLI, hooks, or MCP server.

## Development

```bash
npm run dev          # local web app
npm run test         # unit tests
npm run typecheck    # TypeScript project checks
npm run lint         # Oxlint, warnings denied
npm run build        # core + integration + plugin runtime + web
npm run check        # complete release gate
```

Repository layout:

```text
apps/web/                 Visual estimator
packages/core/            Pure forecasting and calibration engine
packages/integration/     CLI, hooks, repository profiler, history, and MCP
plugins/agent-eta/        Codex/Claude Code plugin bundle
docs/research.md          Evidence, model design, and limitations
```

## Interpreting a result

Use **About** for a rough expectation. Use **Allow up to** for a meeting, a handoff, or deciding whether to start another task. A wide gap is useful information: reduce ambiguity, specify verification, or split the work before delegating. The structured API keeps the technical field names `p50` and `p80` for compatibility.

Do not read “80% by 14 minutes” as “80% complete after 11 minutes.” It is a pre-run distribution over comparable outcomes, not a live completion percentage. Until your observed P80 coverage approaches 80%, treat the interval as a structured heuristic rather than a calibrated probability.

## License

[MIT](LICENSE)
