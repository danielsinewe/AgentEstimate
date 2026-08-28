# `@agent-eta/core`

A deterministic, provider-neutral ETA engine for coding-agent tasks. It breaks
work into **Orient → Reason → Change → Verify → Deliver**, then returns p25,
p50, p80, and p95 durations from a seeded Monte Carlo simulation.

```ts
import { estimateTask } from '@agent-eta/core';

const estimate = estimateTask({
  prompt: 'Add a settings form and test it in the browser.',
  provider: 'codex',
  model: 'gpt-5.6-codex',
  effort: 'high',
  speed: 'standard',
  repo: { fileCount: 420, linesOfCode: 82_000 },
});

console.log(estimate.formatted.p50, estimate.formatted.p95);
```

## What the model uses

- Prompt-derived task class, scope, ambiguity, and operational signals.
- Explicit caller overrides for tests, browser work, external dependencies,
  deployment, destructive safeguards, and expected file count.
- Model × effort × speed interactions. Fast mode changes only the three
  model-bound stages; it cannot pretend tests or deployments run faster.
- Repository shape as a capped, weak logarithmic prior. A large repository
  matters most during orientation and cannot dominate task scope.
- Optional personal history through robust hierarchical calibration. Ratios
  are winsorized, cohorts shrink toward broader priors, and the final
  multiplier is clamped to `0.6…1.75`.

## Privacy

The package is pure and has no filesystem, database, telemetry, or network
code. Prompt text is analyzed in-memory, is not copied into the output, and is
not used to derive the default random seed. Persistence is entirely the
caller's choice.

These are planning distributions, not promises. The stage breakdown, drivers,
assumptions, and confidence spread are included so callers can explain why an
estimate moved.
