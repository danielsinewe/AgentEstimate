import { analyzePrompt } from './prompt.js';
import type {
  CalibrationContext,
  CalibrationLevel,
  CalibrationResult,
  CalibrationSample,
  EstimateInput,
  TaskClass,
} from './types.js';

const CALIBRATION_BOUNDS = [0.55, 1.8] as const;
const LEARNING_RATIO_BOUNDS = [0.08, 8] as const;
const ROBUST_RATIO_BOUNDS = [0.25, 4] as const;
const CENTER_PRIOR_STRENGTH = 8;

interface WeightedValue {
  value: number;
  weight: number;
}

interface WeightedSample {
  sample: CalibrationSample;
  weight: number;
  logRatio: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

const weightedQuantile = (items: readonly WeightedValue[], probability: number): number => {
  if (items.length === 0) return 0;
  const sorted = [...items].sort((first, second) => first.value - second.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const target = clamp(probability, 0, 1) * totalWeight;
  let cumulative = 0;
  let previousPosition = 0;
  let previousValue = sorted[0]?.value ?? 0;
  for (const item of sorted) {
    const position = cumulative + item.weight / 2;
    if (target <= position) {
      if (position <= previousPosition) return item.value;
      const fraction = clamp((target - previousPosition) / (position - previousPosition), 0, 1);
      return previousValue + (item.value - previousValue) * fraction;
    }
    previousPosition = position;
    previousValue = item.value;
    cumulative += item.weight;
  }
  return sorted.at(-1)?.value ?? 0;
};

const weightedMean = (items: readonly WeightedValue[]): number => {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return 0;
  return items.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
};

/** A winsorized weighted log center resists stopped timers and runaway tasks. */
const robustLogCenter = (samples: readonly WeightedSample[]): number => {
  const values = samples.map(({ logRatio, weight }) => ({ value: logRatio, weight }));
  if (values.length === 0) return 0;
  const center = weightedQuantile(values, 0.5);
  const mad = weightedQuantile(
    values.map((item) => ({ value: Math.abs(item.value - center), weight: item.weight })),
    0.5,
  );
  const limit = Math.max(0.18, 2.5 * 1.4826 * mad);
  return weightedMean(
    values.map((item) => ({
      value: clamp(item.value, center - limit, center + limit),
      weight: item.weight,
    })),
  );
};

const robustDispersionMultiplier = (
  samples: readonly WeightedSample[],
  effectiveSampleCount: number,
): number => {
  if (samples.length < 8 || effectiveSampleCount < 6) return 1;
  const values = samples.map(({ logRatio, weight }) => ({ value: logRatio, weight }));
  const center = weightedQuantile(values, 0.5);
  const robustScale = Math.max(
    0.08,
    1.4826 * weightedQuantile(
      values.map((item) => ({ value: Math.abs(item.value - center), weight: item.weight })),
      0.5,
    ),
  );
  const rawMultiplier = clamp(robustScale / 0.34, 0.65, 1.8);
  const evidenceWeight = effectiveSampleCount / (effectiveSampleCount + 12);
  return 1 + (rawMultiplier - 1) * evidenceWeight;
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

const candidateSamples = (samples: readonly CalibrationSample[]): CalibrationSample[] =>
  samples.filter(
    (sample) =>
      Number.isFinite(sample.estimatedMinutes) &&
      Number.isFinite(sample.actualMinutes) &&
      sample.estimatedMinutes > 0 &&
      sample.actualMinutes > 0,
  );

const similarityWeight = (sample: CalibrationSample, target: CalibrationContext): number => {
  let weight = 0.28;
  if (target.provider && sample.provider) weight *= sample.provider === target.provider ? 1.75 : 0.55;
  if (target.taskClass && sample.taskClass) weight *= sample.taskClass === target.taskClass ? 1.75 : 0.5;
  if (target.model && sample.model) {
    weight *= sample.model.trim().toLowerCase() === target.model.trim().toLowerCase() ? 1.35 : 0.82;
  }
  if (target.effort && sample.effort) weight *= sample.effort === target.effort ? 1.18 : 0.86;
  if (target.speed && sample.speed) weight *= sample.speed === target.speed ? 1.12 : 0.9;
  return clamp(weight, 0.08, 1);
};

const calibrationLevel = (
  samples: readonly CalibrationSample[],
  target: CalibrationContext,
): { level: CalibrationLevel; matchedSampleCount: number } => {
  const model = target.model?.trim().toLowerCase();
  const exact = samples.filter((sample) =>
    (!target.provider || sample.provider === target.provider) &&
    (!target.taskClass || sample.taskClass === target.taskClass) &&
    (!model || sample.model?.trim().toLowerCase() === model) &&
    (!target.effort || sample.effort === target.effort) &&
    (!target.speed || sample.speed === target.speed),
  );
  if (exact.length >= 4 && Boolean(model || target.effort || target.speed)) {
    return { level: 'model-effort', matchedSampleCount: exact.length };
  }
  const providerTask = samples.filter((sample) =>
    (!target.provider || sample.provider === target.provider) &&
    (!target.taskClass || sample.taskClass === target.taskClass),
  );
  if (providerTask.length >= 3 && target.provider && target.taskClass) {
    return { level: 'provider-task', matchedSampleCount: providerTask.length };
  }
  const task = samples.filter((sample) => !target.taskClass || sample.taskClass === target.taskClass);
  if (task.length >= 2 && target.taskClass) return { level: 'task', matchedSampleCount: task.length };
  const provider = samples.filter((sample) => !target.provider || sample.provider === target.provider);
  if (provider.length >= 2 && target.provider) return { level: 'provider', matchedSampleCount: provider.length };
  return { level: 'global', matchedSampleCount: samples.length };
};

const coverageMultiplier = (
  samples: readonly WeightedSample[],
  key: 'estimatedP80Minutes' | 'estimatedP95Minutes',
  probability: number,
  minimumSamples: number,
  effectiveSampleCount: number,
  fallback: number,
): number => {
  const values = samples.flatMap(({ sample, weight }) => {
    const estimate = sample[key];
    if (!Number.isFinite(estimate) || (estimate ?? 0) <= 0) return [];
    return [{
      value: Math.log(clamp(sample.actualMinutes / (estimate ?? 1), ...ROBUST_RATIO_BOUNDS)),
      weight,
    }];
  });
  if (values.length < minimumSamples) return fallback;
  const rawCorrection = weightedQuantile(values, probability);
  const evidenceWeight = effectiveSampleCount / (effectiveSampleCount + (probability >= 0.95 ? 18 : 12));
  return clamp(Math.exp(rawCorrection * evidenceWeight), ...CALIBRATION_BOUNDS);
};

/**
 * Builds a personal correction from one similarity-weighted evidence pool.
 * Each historical run contributes once, so overlapping cohorts cannot amplify
 * a tiny sample. Extreme stop boundaries remain auditable but are quarantined.
 */
export const calibrate = (
  samples: readonly CalibrationSample[],
  context: CalibrationContext | EstimateInput | TaskClass,
): CalibrationResult => {
  const candidates = candidateSamples(samples);
  const target = normalizeContext(context);
  const usable = candidates.filter((sample) => {
    const ratio = sample.actualMinutes / sample.estimatedMinutes;
    return ratio >= LEARNING_RATIO_BOUNDS[0] && ratio <= LEARNING_RATIO_BOUNDS[1];
  });
  const excludedSampleCount = candidates.length - usable.length;

  if (usable.length === 0) {
    return {
      multiplier: 1,
      dispersionMultiplier: 1,
      quantileMultipliers: { p50: 1, p80: 1, p95: 1 },
      sampleCount: candidates.length,
      matchedSampleCount: 0,
      effectiveSampleCount: 0,
      excludedSampleCount,
      level: 'none',
      applied: false,
      bounds: CALIBRATION_BOUNDS,
    };
  }

  const weighted = usable.map((sample) => ({
    sample,
    weight: similarityWeight(sample, target),
    logRatio: Math.log(clamp(sample.actualMinutes / sample.estimatedMinutes, ...ROBUST_RATIO_BOUNDS)),
  }));
  const effectiveSampleCount = weighted.reduce((sum, sample) => sum + sample.weight, 0);
  const evidenceWeight = effectiveSampleCount / (effectiveSampleCount + CENTER_PRIOR_STRENGTH);
  const multiplier = clamp(Math.exp(robustLogCenter(weighted) * evidenceWeight), ...CALIBRATION_BOUNDS);
  const dispersionMultiplier = robustDispersionMultiplier(weighted, effectiveSampleCount);
  const p80Multiplier = coverageMultiplier(
    weighted,
    'estimatedP80Minutes',
    0.8,
    6,
    effectiveSampleCount,
    multiplier,
  );
  const p95Multiplier = coverageMultiplier(
    weighted,
    'estimatedP95Minutes',
    0.95,
    12,
    effectiveSampleCount,
    multiplier,
  );
  const { level, matchedSampleCount } = calibrationLevel(usable, target);
  const roundedMultiplier = round(multiplier);
  const roundedDispersion = round(dispersionMultiplier);
  const quantileMultipliers = {
    p50: roundedMultiplier,
    p80: round(p80Multiplier),
    p95: round(p95Multiplier),
  };

  return {
    multiplier: roundedMultiplier,
    dispersionMultiplier: roundedDispersion,
    quantileMultipliers,
    sampleCount: candidates.length,
    matchedSampleCount,
    effectiveSampleCount: round(effectiveSampleCount),
    excludedSampleCount,
    level,
    applied:
      Math.abs(roundedMultiplier - 1) >= 0.005 ||
      Math.abs(roundedDispersion - 1) >= 0.025 ||
      Math.abs(quantileMultipliers.p80 - roundedMultiplier) >= 0.025 ||
      Math.abs(quantileMultipliers.p95 - roundedMultiplier) >= 0.025,
    bounds: CALIBRATION_BOUNDS,
  };
};
