---
name: estimate
description: Estimate how long a Codex or Claude Code task will take when the user asks for an ETA, duration range, or timing forecast.
---

# Estimate a coding-agent task

Use the `estimate_task` MCP tool with the user's actual task and the active repository. Pass the known provider, model, reasoning effort, and speed mode; leave unknown values unset instead of inventing them.

Lead with the P50 and P80 forecast. Describe P50 as the likely duration and P80 as the safer planning bound. Mention at most three material drivers when they help the user make the task smaller or more predictable.

Treat the result as a forecast, not a promise or a completion percentage. Repository size is a weak signal; scope, ambiguity, external systems, verification, browser work, and deployment are stronger signals.

Use `current_run` when the user asks about work already in progress. Use `calibration_status` when they ask how much local evidence supports the estimate.

Agent ETA processes prompts locally. Never copy prompts, source code, tool output, secrets, or transcripts into history or other storage.
