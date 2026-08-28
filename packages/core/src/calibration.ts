import { analyzePrompt } from './prompt.js';
import type {
  CalibrationContext,
  CalibrationLevel,
  CalibrationResult,
  CalibrationSample,
  EstimateInput,
  TaskClass,
} from './types.js';

const CALIBRATION_BOUNDS = [0.6, 1.75] as const;
const RATIO_BOUNDS = [0.25, 4] as const;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** A winsorized log center resists a few stopped timers or runaway tasks. */
const robustLogCenter = (samples: readonly CalibrationSample[]): number => {
  const values = samples.map((sample) =>
    Math.log(clamp(sample.actualMinutes / sample.estimatedMinutes, ...RATIO_BOUNDS)),
  );
  if (values.length === 0) return 0;

  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  const limit = Math.max(0.18, 2.5 * 1.4826 * mad);
  const winsorized = values.map((value) => clamp(value, center - limit, center + limit));
  return winsorized.reduce((sum, value) => sum + value, 0) / winsorized.length;
};

const robustDispersionMultiplier = (samples: readonly CalibrationSample[]): number => {
  if (samples.length < 8) return 1;
  const values = samples.map((sample) =>
    Math.log(clamp(sample.actualMinutes / sample.estimatedMinutes, ...RATIO_BOUNDS)),
  );
  const center = median(values);
  const robustScale = Math.max(0.08, 1.4826 * median(values.map((value) => Math.abs(value - center))));
  const rawMultiplier = clamp(robustScale / 0.34, 0.65, 1.8);
  const evidenceWeight = samples.length / (samples.length + 12);
  return 1 + (rawMultiplier - 1) * evidenceWeight;
};

const shrinkToward = (
  prior: number,
  samples: readonly CalibrationSample[],
  priorStrength: number,
): number => {
  if (samples.length === 0) return prior;
  const weight = samples.length / (samples.length + priorStrength);
  return prior * (1 - weight) + robustLogCenter(samples) * weight;
};

const isEstimateInput = (value: CalibrationContext | EstimateInput): value is EstimateInput =>
  'prompt' in value && typeof value.prompt === 'string';

const normalizeContext = (
  context: CalibrationContext | EstimateInput | TaskClass,
): CalibrationContext => {
  if (typeof context === 'string') return { taskClass: context };
  if (!isEstimateInput(context)) return context;
  return {
    taskClass: context.taskClass ?? analyzePrompt(context.prompt).taskClass,
    provider: context.provider,
    model: context.model,
    effort: context.effort,
    speed: context.speed,
  };
};

const usableSamples = (samples: readonly CalibrationSample[]): CalibrationSample[] =>
  samples.filter(
    (sample) =>
      Number.isFinite(sample.estimatedMinutes) &&
      Number.isFinite(sample.actualMinutes) &&
      sample.estimatedMinutes > 0 &&
      sample.actualMinutes > 0,
  );

/**
 * Builds a personal multiplier through progressively more specific cohorts.
 * Every cohort is shrunk toward its parent, and the final result is clamped.
 */
export const calibrate = (
  samples: readonly CalibrationSample[],
  context: CalibrationContext | EstimateInput | TaskClass,
): CalibrationResult => {
  const usable = usableSamples(samples);
  if (usable.length === 0) {
    return {
      multiplier: 1,
      dispersionMultiplier: 1,
      sampleCount: 0,
      matchedSampleCount: 0,
      level: 'none',
      applied: false,
      bounds: CALIBRATION_BOUNDS,
    };
  }

  const target = normalizeContext(context);
  let logMultiplier = shrinkToward(0, usable, 12);
  let matchedSampleCount = usable.length;
  let dispersionSamples: readonly CalibrationSample[] = usable;
  let level: CalibrationLevel = 'global';

  const applyLevel = (
    cohort: readonly CalibrationSample[],
    nextLevel: CalibrationLevel,
    priorStrength: number,
    minimumSamples: number,
  ): void => {
    if (cohort.length < minimumSamples) return;
    logMultiplier = shrinkToward(logMultiplier, cohort, priorStrength);
    matchedSampleCount = cohort.length;
    level = nextLevel;
    if (cohort.length >= 8) dispersionSamples = cohort;
  };

  const providerSamples = target.provider
    ? usable.filter((sample) => sample.provider === target.provider)
    : [];
  applyLevel(providerSamples, 'provider', 7, 2);

  const taskSamples = target.taskClass
    ? usable.filter((sample) => sample.taskClass === target.taskClass)
    : [];
  applyLevel(taskSamples, 'task', 6, 2);

  const providerTaskSamples =
    target.provider && target.taskClass
      ? usable.filter(
          (sample) =>
            sample.provider === target.provider && sample.taskClass === target.taskClass,
        )
      : [];
  applyLevel(providerTaskSamples, 'provider-task', 4, 3);

  const normalizedModel = target.model?.trim().toLowerCase();
  const exactSamples = usable.filter((sample) => {
    if (target.taskClass && sample.taskClass !== target.taskClass) return false;
    if (target.provider && sample.provider !== target.provider) return false;
    if (normalizedModel && sample.model?.trim().toLowerCase() !== normalizedModel) return false;
    if (target.effort && sample.effort !== target.effort) return false;
    if (target.speed && sample.speed !== target.speed) return false;
    return Boolean(normalizedModel || target.effort || target.speed);
  });
  applyLevel(exactSamples, 'model-effort', 3, 4);

  const multiplier = clamp(Math.exp(logMultiplier), ...CALIBRATION_BOUNDS);
  const dispersionMultiplier = robustDispersionMultiplier(dispersionSamples);
  return {
    multiplier: Math.round(multiplier * 1000) / 1000,
    dispersionMultiplier: Math.round(dispersionMultiplier * 1000) / 1000,
    sampleCount: usable.length,
    matchedSampleCount,
    level,
    applied: Math.abs(multiplier - 1) >= 0.005 || Math.abs(dispersionMultiplier - 1) >= 0.025,
    bounds: CALIBRATION_BOUNDS,
  };
};
