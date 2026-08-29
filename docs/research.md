# Agent ETA: research and forecasting method

**Research snapshot:** 29 August 2026
**Product:** [Agent ETA](https://agentestimate.vercel.app)
**Forecast target:** wall-clock time from task submission until the coding agent returns control

## Executive conclusion

A coding-agent ETA should be a planning distribution, not a single countdown. The strongest pre-run signals are the requested outcome, task class, scope, ambiguity, verification loops, external systems, deployment, model, effort, and speed mode. Repository size contributes information, but only as a weak prior: agents inspect a selective slice of most repositories, and a one-line production bug can take longer than a broad mechanical edit.

The cold-start model now also separates bounded micro-tasks from vague product-level requests, prices interactions between sequential feedback loops, and includes an explicit low-probability rework state. This keeps simple commands small without creating falsely narrow P80/P95 ranges for ambiguous integration work.

The strongest long-run signal is personal history measured at stable lifecycle boundaries. Agent ETA therefore combines four surfaces:

1. a manual web estimator for immediate value;
2. a deterministic local engine for reproducibility;
3. MCP tools for agent-initiated estimates and status reads; and
4. passive hooks for automatic start/stop capture and calibration.

The resulting P50 and P80 are forecasts of when the agent returns control. They do not prove the implementation is correct, deployed, reviewed, or accepted by a human.

## What the probabilities mean

Before a run begins, imagine a reference class of comparable tasks under similar conditions:

- **P50** is the median. About half should finish sooner and half later.
- **P80** is the planning bound. About four in five should finish sooner if the forecast is calibrated.
- **P95** represents a tail case, not a worst case. Unbounded outages, permission blocks, and human waits can still exceed it.

These are predictive quantiles, not percentages complete. Once a task has been running for ten minutes, its original P80 does not imply that a known fraction of the work is done. A proper live remaining-time model would need evidence from the unfolding tool sequence and a survival model; Agent ETA does not pretend to have that evidence yet.

Cold-start probabilities are structured heuristic ranges. The `calibration_status` tool reports observed P50 and P80 coverage so probability language can be checked against actual local outcomes.

## How the product communicates the range

The engine and structured API retain predictive quantiles because they are the auditable mathematical contract. The default user interface does not require people to decode those names:

- **Likely** is the modeled midpoint: about half of comparable runs should finish sooner.
- **Safer plan** leaves room for slower runs: about four in five should finish sooner once observed history supports that coverage.
- **P50/P80** remain available in technical documentation, structured output, and calibration analysis.

This is progressive disclosure, not a loss of precision. The first view answers the user's decision—“when should I expect it, and how much time should I allow?”—while the methodology keeps the exact statistical meaning inspectable.

## Official-source review

The research intentionally prioritizes first-party product documentation. Third-party anecdotes are noisy, usually omit task definition and stopping rules, and often measure perceived latency rather than a complete coding-agent turn.

| Evidence | What it establishes | Product decision |
| --- | --- | --- |
| OpenAI's original [Introducing Codex](https://openai.com/index/introducing-codex/) described tasks as commonly taking roughly 1–30 minutes depending on complexity. | Agent turns occupy a meaningful, broad wall-clock range. This is historical context, not a current benchmark or training dataset. | Use it only as a broad sanity check; never promise that all runs fit that interval. |
| Codex [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) emits JSONL lifecycle events and final token usage. | Structured run histories can expose starts, completions, item types, and usage without scraping terminal text. | Provide an experimental history adapter, but do not depend on unstable transcript shapes for the primary path. |
| Codex [hooks](https://learn.chatgpt.com/docs/hooks) expose prompt, tool, subagent, stop, and session lifecycle events, and non-managed hooks must be reviewed and trusted before they run. | Hooks can measure runs passively at semantically useful boundaries, but installation alone does not prove activation. | Use prompt-submit and completion hooks for automatic local calibration; document the trust canary, make failures visible, and keep blocking opt-in. |
| Codex [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) and [App Server](https://learn.chatgpt.com/docs/app-server) document telemetry and structured turn events. | Future estimators can add time to first token, tool duration, approvals, retries, and turn state. | Keep the storage schema derived and extensible, but do not require telemetry for the MVP. |
| Codex [speed configuration](https://learn.chatgpt.com/docs/agent-configuration/speed) documents roughly 1.5× speed on supported models, with a usage trade-off. | Speed is a model-execution factor, not a universal wall-clock divisor. | Compress Orient/Reason/Change only; do not accelerate Verify or Deliver. |
| Claude Code [hooks](https://code.claude.com/docs/en/hooks) expose lifecycle events across its supported environments. | The same passive-measurement strategy is available for Claude Code. | Package lifecycle hooks with the local plugin. |
| Claude Code's [status line](https://code.claude.com/docs/en/statusline) exposes model, effort, fast mode, context use, duration, cost, and line changes. | Runtime and configuration signals are available without guessing from prompt length alone. | Normalize model, effort, and speed; reserve richer live progress for a later version. |
| Claude Code [monitoring](https://code.claude.com/docs/en/monitoring-usage) exposes OpenTelemetry metrics and events. | Organization-level data can measure latency, tokens, cost, tools, and outcomes at scale. | Keep an OTel adapter possible, but default to zero external telemetry and local history. |
| Claude Code [model configuration](https://code.claude.com/docs/en/model-config) distinguishes model selection and effort. | Model and effort are separate ETA inputs. | Model affects pace/capability; effort changes stage time, especially reasoning. |
| Claude Code [fast mode](https://code.claude.com/docs/en/fast-mode) describes up to roughly 2.5× output-token speed while noting that time to first token is not improved. | “Fast” cannot be applied uniformly to total task duration. | Treat speed as a bounded interaction on model-bound stages, not a 2.5× end-to-end promise. |
| METR's [time-horizon methodology](https://metr.org/time-horizons/) measures the human-equivalent difficulty of tasks agents can complete at a given reliability. | Capability time horizons are not the same variable as agent wall-clock execution time. | Do not use METR horizon values as ETA labels. They may inform task difficulty research, not minutes-until-return. |
| OpenAI's 2026 [agent-work study](https://openai.com/index/how-agents-are-transforming-work/) shows that users increasingly delegate longer, multi-step work and explicitly labels its human-time thresholds as directional estimates. | Real usage spans short interactions and long-horizon delegated work, but human-equivalent task time is still not agent runtime. | Preserve a broad task range while keeping the forecast target strictly return-to-control time. |
| Gneiting, Balabdaoui, and Raftery's [probabilistic forecast framework](https://doi.org/10.1111/j.1467-9868.2007.00587.x) defines the goal as sharp predictive distributions subject to calibration. | A range should not be widened indiscriminately just to catch every outcome. | Track coverage and interval width together; prefer evidence-weighted correction over blanket padding. |
| Jørgensen's [probabilistic software-effort evaluation](https://doi.org/10.1016/j.infsof.2019.08.006) applies the same calibration-and-informativeness principle to software work. | P50/P80 labels are only useful when their observed coverage is auditable. | Store original quantiles, report coverage, and learn quantile-specific corrections when enough local evidence exists. |
| Grounds, Joslyn, and Otsuka's [two experiments on predictive interval forecasts](https://doi.org/10.1155/2017/3932565) found that intervals improved decisions across student and general-population samples, while some users still fundamentally misread the bounds. Text and frequency explanations helped. | A range is useful, but unexplained statistical notation and ambiguous graphics are not self-explanatory. | Lead with two concrete times and plain labels; keep the statistical terms out of the default view. |
| Teigen and colleagues' [review of numeric ranges and uncertainty](https://pmc.ncbi.nlm.nih.gov/articles/PMC9660216/) reports that people often confuse interval width with confidence, treat values inside a range as equally likely, and fail to distinguish confidence levels in software estimates. | Showing P50/P80 does not guarantee a working understanding, even for software practitioners. | Explain the decision meaning instead of expecting users to translate percentiles. |
| van der Bles and colleagues' [experiments on communicating uncertainty](https://doi.org/10.1073/pnas.1913678117) recommend a numeric range with a point estimate and found that uncertainty need not reduce trust in the source. | Hiding uncertainty is unnecessary; contextualizing it is the important part. | Keep both a likely time and a safer time rather than collapsing to one confident-looking number. |
| The ONS [plain-language standard](https://service-manual.ons.gov.uk/content/writing-for-users/plain-language) and GOV.UK [UI writing guidance](https://www.gov.uk/service-manual/design/writing-for-user-interfaces) advise avoiding unexplained technical terms and minimizing cognitive load, including for specialists. | Expert audiences also benefit from direct, scannable labels. | Use “Likely” and “Safer plan” in the product; reserve P50/P80 for technical drill-downs. |

### Evidence that was deliberately not treated as ground truth

- Marketing speed multipliers are workload- and surface-specific. They cannot be multiplied across the entire task.
- Token throughput is not end-to-end latency. Tool execution, queues, tests, browsers, approvals, and deployment can dominate.
- Repository line count is not task complexity. It mainly affects discovery cost.
- METR human-task duration is not agent execution duration.
- A host reporting “completed” means the agent stopped; it does not prove the requested outcome is correct.
- Community timing anecdotes lack stable task classes, model settings, hardware, service tier, verification requirements, and censoring rules.

## Why hooks, MCP, and a web app all exist

No single integration surface solves the complete problem.

**MCP is explicit and read-oriented.** It is ideal when a user or agent asks “How long will this take?” The `estimate_task`, `current_run`, and `calibration_status` tools are read-only. But an autonomous agent may not call an optional MCP tool, so MCP alone cannot produce a complete run ledger.

**Hooks are passive.** Prompt-submit and completion events provide consistent boundaries and can record outcomes without asking the agent to remember. Hooks must be fast. Normal mode fails visibly and continues; optional strict mode blocks a prompt only when no forecast can be produced.

**The web app is frictionless.** It gives a useful cold-start estimate before anything is installed, allows local repository scanning, and records manually entered actual durations in that browser only.

**The core library keeps all surfaces honest.** Web, CLI, hooks, and MCP call the same provider-neutral deterministic function instead of drifting into separate rules.

## The forecasting model

Agent ETA is a staged reference-class simulation. It is intentionally inspectable and deterministic, not a fitted black box.

### 1. Prompt-derived task description

The analyzer derives categories, never prompt excerpts:

- task class: question, research, review, diagnose, bugfix, feature, refactor, or migration;
- scope: micro, small, medium, large, or project;
- ambiguity: low, medium, or high;
- expected loops: external service, tests, browser work, deployment, and destructive-operation safeguards;
- counts: characters, words, lines, checklist items, and action-oriented structure.

Terse reply-only commands and explicit one-line edits receive bounded micro-task treatment. Conversely, phrases such as “make the app better” and “impress me” increase both inferred scope and ambiguity instead of masquerading as tiny feature work.

Callers can override inferred facts. Explicit task metadata is more reliable than keyword inference.

### 2. Five-stage decomposition

Every task is decomposed into:

| Stage | Meaning | Model-bound? |
| --- | --- | --- |
| Orient | Locate relevant code, constraints, and state | Yes |
| Reason | Plan, diagnose, research, and choose an approach | Yes |
| Change | Write or modify the deliverable | Yes |
| Verify | Run tests, inspect UI, and read back external state | No |
| Deliver | Summarize, commit, push, deploy, or hand off | No |

Each task class has a stage baseline. Scope and ambiguity apply different weights by stage: ambiguity affects Reason more than Deliver, while repository size affects Orient far more than Change.

### 3. Configuration and operational factors

For each stage center, the engine combines:

- task-class baseline;
- scope and ambiguity factors;
- provider/model pace and capability tier;
- reasoning effort;
- explicit expected file count when supplied;
- additive time for tests, browser work, external systems, deployment, and destructive safeguards;
- pairwise interaction time when several of those loops must happen sequentially;
- personal calibration multiplier.

Fast mode is applied only to Orient, Reason, and Change. Higher effort and already-fast model tiers receive a smaller speed reduction. Verify and Deliver stay anchored to real tool and service time.

Model names are mapped into broad tiers by transparent name patterns. Unknown names receive a neutral prior. This makes the engine resilient to new model identifiers, but it is not a live benchmark of every model release.

### 4. Repository prior

The local profiler derives aggregate shape from Git-tracked and unignored files when possible, falling back to a bounded filesystem scan. It excludes dependency trees, build products, common generated directories, and binary formats. Line counts are estimated from a deterministic code-file sample.

The repository multiplier uses capped logarithms of file count, estimated lines, tests, languages, dependencies, and package count. Its total increment is capped, and stage weights make it strongest during orientation. This expresses a modest “more surface to search” prior without equating a large repository with a hard task.

### 5. Correlated uncertainty and rework simulation

For each stage `s`, a center `μs` is calculated from the factors above. The engine then produces 1,600 samples:

```text
T(i) = Σs T(i,s)

T(i,s) = μs × exp(σs × (0.48 × Zshared + 0.877 × Zstage)) × (1 + Ws × Ri)

Ri = Bi × (0.22 + 0.34 × |Zrework|)

Bi ~ Bernoulli(π)
```

`Zshared` makes a generally easy or difficult run move all stages together. `Zstage` preserves stage-specific surprises. `σ` increases with ambiguity, external dependencies, research/diagnosis, and limited calibration. The log-normal form keeps time positive and produces the long tail common in software work.

`Bi` represents a low-probability rework or blocker state. Its probability `π` rises with ambiguity, external services, deployment, destructive work, diagnosis, and migration. The stage weight `Ws` is strongest in verification and change. This mixture makes the P80/P95 react to unknown-unknowns without inflating the median of every clear local task.

The engine sorts the simulated totals to return P25, P50, P80, P95, and the arithmetic mean. A stable default seed is independent of prompt text. The same normalized input and calibration history therefore produce the same result, which makes changes testable and what-if comparisons meaningful.

### 6. Robust personal calibration

For successful runs, calibration starts from the ratio:

```text
actual elapsed minutes / original P50 minutes
```

It estimates a robust center in log space, limits extreme ratios, and winsorizes deviations around a weighted median. Each historical run receives one similarity weight from task class, provider, model, effort, and speed. It is counted exactly once; overlapping cohort labels cannot amplify the same two samples. The weighted result is shrunk toward the cold-start prior according to effective sample size.

Stop boundaries with an actual/P50 ratio below `0.08` or above `8` remain visible in history but are quarantined from learning. This protects the model from reply-only tests, interrupted sessions incorrectly reported as clean stops, and runaway timers. The final center multiplier is clamped to `0.55…1.80`. With enough comparable samples, robust residual dispersion adjusts interval width. When original P80/P95 values are available, empirical upper-quantile residuals add separately shrunk coverage corrections rather than assuming a center correction fixes the tail.

Personalization adapts the center, residual width, and—when evidence supports it—upper quantiles. Empirical P50/P80 coverage remains the test of whether the distribution is trustworthy. The status label becomes `personalized`, never `calibrated`, because sample count alone cannot certify coverage.

## Privacy and threat boundary

Agent ETA is local-first by construction.

### What is processed transiently

- The prompt is analyzed in process memory.
- A bounded sample of local source files is read to count lines and languages.
- A transient prompt fingerprint may help deduplicate a run when a host does not provide a turn ID.
- Experimental JSONL import reads historical prompts locally to derive features.

### What is stored

- derived prompt counts, task class, scope, ambiguity, and loop booleans;
- aggregate repository metrics;
- provider, normalized model, effort, and speed;
- initial forecast quantiles and confidence;
- timestamps, elapsed duration, and success/failed/censored outcome;
- install-salted HMAC identifiers for run, session, and repository identity.

### What is not stored by Agent ETA

- raw prompts or prompt fragments;
- source code, diffs, filenames, repository paths, tool output, transcripts, secrets, or credentials;
- unsalted prompt hashes;
- external analytics identifiers.

The browser stores derived manual calibration samples in `localStorage`. The integration store is an append-only local JSONL file with restrictive permissions where the operating system supports them. Core, CLI, hooks, and MCP contain no product telemetry or remote API calls. A deployment host still receives ordinary web requests needed to serve the static application; selected directories remain inside the browser and are not uploaded by the application.

This boundary does not protect a machine that is already compromised, an untrusted browser extension, or a user who manually exports and shares the local history file.

## Measurement semantics

The hook path measures elapsed wall-clock time between host lifecycle events. That is useful because it reflects the user's wait, but it can include:

- model queueing and API latency;
- local tool and test execution;
- network, browser, and deployment latency;
- approval prompts and service throttling;
- host-specific time before a stop event is emitted.

A clean stop is recorded as success because the host has returned normally, not because an independent verifier accepted the work. Failure and session-end outcomes are stored separately. Runs without a reliable completion boundary should be treated as censored and excluded from duration calibration.

Cross-provider comparisons are therefore directional unless both hosts use equivalent start, stop, approval, and background-task semantics.

## Known limitations

1. **Cold start is heuristic.** The baseline is engineered from stage priors and official product behavior, not trained on a large cross-user timing dataset.
2. **Prompt quality matters.** Hidden requirements, unstated verification, and ambiguous “make it perfect” requests widen real outcomes beyond what text classification can know.
3. **Model mappings can drift.** New models and provider-side changes can alter pace before the static tier mapping is updated.
4. **Service conditions are unmodeled.** Queue congestion, rate limits, outages, cached context, and account tier can dominate a run.
5. **Concurrency is simplified.** Subagents and parallel tools can reduce elapsed time while adding coordination overhead; the current engine has no explicit concurrency graph.
6. **Repository scans are sampled.** Aggregate size can be approximate, especially outside Git or in unusually generated repositories.
7. **Hook schemas differ.** Codex and Claude Code lifecycle and transcript formats can evolve, and prompt-submit events do not consistently expose active effort or speed. Hooks label fallback assumptions, accept explicit `AGENT_ETA_MODEL`, `AGENT_ETA_EFFORT`, and `AGENT_ETA_SPEED` overrides, and surface failures without blocking by default. `AGENT_ETA_STRICT=1` can require a forecast; JSONL history import remains experimental.
8. **Completion is not correctness.** A stop event does not prove tests passed, a deployment is healthy, or the requested product outcome works.
9. **No live survival update yet.** `current_run` reports elapsed time against the initial range; it does not infer remaining time from tool progress.
10. **Human time is not modeled separately.** Approval and clarification waits may enter elapsed wall time even though they are not model compute.
11. **Cold-start scenario bounds are engineered, not learned population statistics.** Regression contracts prevent obvious category failures, while real chronological histories must determine eventual coverage.

## Validation plan

Accuracy should be judged by held-out chronological runs, not by how plausible individual numbers look.

Track at least:

- median absolute error in minutes;
- median absolute percentage error, with care around very short tasks;
- observed P50 coverage, targeting approximately 50%;
- observed P80 coverage, targeting approximately 80%;
- interval width and sharpness by task class;
- calibration split by provider, model, effort, speed, and repository cohort;
- failure and censoring rate;
- hook overhead and missing-boundary rate.

Evaluation should freeze a model version, predict each new run before adding its outcome, and compare against simple baselines such as a global median and a task-class median. A more complex model earns its place only if it improves held-out calibration or sharpness without weakening privacy and explainability.

The repository also maintains deterministic scenario contracts for reply-only commands, one-line edits, vague product work, multi-loop integrations, and migrations. These are guardrails against category errors, not substitutes for held-out coverage evaluation.

Useful future upgrades include:

- provider-specific adapters for stable structured run APIs;
- optional OpenTelemetry ingestion with local aggregation;
- time-to-first-token, tool-duration, approval, retry, and queue features;
- explicit subagent/concurrency features;
- survival-based remaining-time updates;
- versioned priors and automated calibration drift reports.

## Design principles

- Report a range, never false single-number precision.
- Make P50 useful and P80 safe enough to plan around.
- Prefer lifecycle evidence over agent self-report.
- Treat repository size as a weak logarithmic prior.
- Accelerate only the stages a speed mode can actually affect.
- Keep raw prompts, code, paths, and transcripts out of storage.
- Fail open: estimation must never block the coding agent.
- Show observed coverage so “P80” can be audited.
- Forecast return-to-control separately from correctness.
