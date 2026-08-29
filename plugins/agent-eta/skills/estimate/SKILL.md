---
name: estimate
description: Estimate how long a Codex or Claude Code task will take when the user asks for an ETA, duration range, or timing forecast.
---

# Estimate a coding-agent task

Use the `estimate_task` MCP tool with the user's actual task. Pass `workspaceRoot` as the current task directory so repository signals come from the project, not the plugin bundle. Pass the known provider, model, reasoning effort, and speed mode; leave unknown values unset instead of inventing them.

Lead with `Agent ETA · likely {p50} · safer plan {p80}`. Use those plain-language labels by default; only mention the technical P50/P80 names when the user asks about probability, calibration, or methodology. Prefer the tool's ranked driver impacts and mention at most three when they help the user make the task smaller or more predictable.

Treat the result as a forecast, not a promise or a completion percentage. Repository size is a weak signal; scope, ambiguity, external systems, verification, browser work, and deployment are stronger signals.

Use `current_run` when the user asks about work already in progress. Pass `workspaceRoot` when the active task directory is known; otherwise it returns the latest active run. Use `calibration_status` when they ask how much local evidence supports the estimate. Do not treat quarantined stop boundaries or raw sample count as proof of calibration; observed coverage is the audit signal.

Agent ETA processes prompts locally. Never copy prompts, source code, tool output, secrets, or transcripts into history or other storage.
