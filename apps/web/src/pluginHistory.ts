import { toLocalRunInput } from './lib/supabase/validation';
import type { WebCalibrationSample } from './localHistory';

const MAX_LINE_LENGTH = 16 * 1024;

type JsonRecord = Record<string, unknown>;

export interface PluginHistoryImportResult {
  runs: WebCalibrationSample[];
  ignoredLines: number;
  incompleteRuns: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function parsePluginHistory(text: string): PluginHistoryImportResult {
  const started = new Map<string, JsonRecord>();
  const completed = new Map<string, JsonRecord>();
  let ignoredLines = 0;

  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (line.length > MAX_LINE_LENGTH) {
      ignoredLines += 1;
      continue;
    }
    try {
      const record: unknown = JSON.parse(line);
      if (!isRecord(record) || typeof record.runId !== 'string') {
        ignoredLines += 1;
      } else if (record.kind === 'started') {
        started.set(record.runId, record);
      } else if (record.kind === 'completed') {
        completed.set(record.runId, record);
      } else {
        ignoredLines += 1;
      }
    } catch {
      ignoredLines += 1;
    }
  }

  const runs: WebCalibrationSample[] = [];
  for (const [runId, start] of started) {
    const completion = completed.get(runId);
    if (!completion || !positiveNumber(completion.elapsedMs)) continue;
    if (!isRecord(start.features) || !isRecord(start.estimate)) continue;
    const prompt = start.features.prompt;
    const minutes = start.estimate.minutes;
    if (!isRecord(prompt) || !isRecord(minutes)) continue;

    const outcome = completion.outcome;
    const candidate = {
      id: runId,
      provider: start.features.provider,
      model: start.features.model,
      effort: start.features.effort,
      speed: start.features.speed,
      taskClass: prompt.taskClass,
      scope: prompt.scope,
      ambiguity: prompt.ambiguity,
      tests: prompt.tests,
      browser: prompt.browser,
      external: prompt.external,
      deploy: prompt.deploy,
      destructive: prompt.destructive,
      estimatedP25Minutes: minutes.p25,
      estimatedMinutes: minutes.p50,
      estimatedP80Minutes: minutes.p80,
      estimatedP95Minutes: minutes.p95,
      actualMinutes: completion.elapsedMs / 60_000,
      successful: outcome === 'success',
      outcome,
      createdAt: start.startedAt,
    };
    const parsed = toLocalRunInput(candidate);
    if (!parsed.ok || parsed.value.actualMinutes === undefined) {
      ignoredLines += 1;
      continue;
    }
    runs.push({
      ...parsed.value,
      actualMinutes: parsed.value.actualMinutes,
      successful: parsed.value.successful === true,
      historySource: 'plugin',
    });
  }

  runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return {
    runs,
    ignoredLines,
    incompleteRuns: [...started.keys()].filter((runId) => !completed.has(runId)).length,
  };
}
