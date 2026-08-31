import { toLocalRunInput, type LocalRunInput } from './lib/supabase/validation';

export const LOCAL_HISTORY_STORAGE_KEY = 'agent-eta-calibration-v1';

export type WebCalibrationSample = LocalRunInput & {
  actualMinutes: number;
  successful: boolean;
  historySource?: 'web' | 'plugin';
};

export function loadLocalHistory(storage: Pick<Storage, 'getItem'> = localStorage): WebCalibrationSample[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LOCAL_HISTORY_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      const result = toLocalRunInput(candidate);
      if (!result.ok || result.value.actualMinutes === undefined) return [];
      const historySource = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).historySource === 'plugin'
        ? 'plugin' as const
        : 'web' as const;
      return [{
        ...result.value,
        actualMinutes: result.value.actualMinutes,
        successful: result.value.successful === true,
        historySource,
      }];
    });
  } catch {
    return [];
  }
}

export function mergeLocalHistory(
  current: readonly WebCalibrationSample[],
  incoming: readonly WebCalibrationSample[],
): WebCalibrationSample[] {
  const merged = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) merged.set(run.id, run);
  return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function saveLocalHistory(
  runs: readonly WebCalibrationSample[],
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(LOCAL_HISTORY_STORAGE_KEY, JSON.stringify(runs));
}
