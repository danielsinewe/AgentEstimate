import { calibrate } from './calibration.js';
import { analyzePrompt } from './prompt.js';
import type {
  AmbiguityLevel,
  DurationQuantiles,
  Effort,
  EstimateDriver,
  EstimateInput,
  EstimateResult,
  PromptAnalysis,
  RepoProfile,
  ScopeLevel,
  StageEstimate,
  StageName,
  TaskClass,
} from './types.js';

interface StageDefinition {
  stage: StageName;
  label: string;
  modelBound: boolean;
}

interface ModelProfile {
  pace: number;
  capability: number;
  label: string;
}

const STAGES: readonly StageDefinition[] = [
  { stage: 'orient', label: 'Orient', modelBound: true },
  { stage: 'reason', label: 'Reason', modelBound: true },
  { stage: 'change', label: 'Change', modelBound: true },
  { stage: 'verify', label: 'Verify', modelBound: false },
  { stage: 'deliver', label: 'Deliver', modelBound: false },
];

const BASE_MINUTES: Record<TaskClass, Record<StageName, number>> = {
  question: { orient: 1, reason: 2, change: 0.2, verify: 0.4, deliver: 0.5 },
  research: { orient: 3, reason: 14, change: 1, verify: 3, deliver: 2 },
  review: { orient: 4, reason: 10, change: 1, verify: 6, deliver: 2 },
  diagnose: { orient: 5, reason: 13, change: 3, verify: 5, deliver: 2 },
  bugfix: { orient: 5, reason: 10, change: 12, verify: 8, deliver: 2 },
  feature: { orient: 6, reason: 10, change: 22, verify: 10, deliver: 3 },
  refactor: { orient: 7, reason: 12, change: 26, verify: 14, deliver: 3 },
  migration: { orient: 9, reason: 16, change: 35, verify: 18, deliver: 5 },
};

const SCOPE_FACTORS: Record<ScopeLevel, number> = {
  micro: 0.24,
  small: 0.62,
  medium: 1,
  large: 1.65,
  project: 2.6,
};

const SCOPE_STAGE_WEIGHTS: Record<StageName, number> = {
  orient: 0.65,
  reason: 0.75,
  change: 1,
  verify: 0.8,
  deliver: 0.35,
};

const AMBIGUITY_FACTORS: Record<AmbiguityLevel, number> = {
  low: 0.9,
  medium: 1,
  high: 1.28,
};

const AMBIGUITY_STAGE_WEIGHTS: Record<StageName, number> = {
  orient: 0.4,
  reason: 1,
  change: 0.55,
  verify: 0.35,
  deliver: 0.15,
};

const EFFORT_FACTORS: Record<Effort, Record<StageName, number>> = {
  low: { orient: 0.9, reason: 0.62, change: 0.88, verify: 0.82, deliver: 0.92 },
  medium: { orient: 1, reason: 1, change: 1, verify: 1, deliver: 1 },
  high: { orient: 1.06, reason: 1.34, change: 1.1, verify: 1.12, deliver: 1.02 },
  xhigh: { orient: 1.12, reason: 1.7, change: 1.16, verify: 1.2, deliver: 1.04 },
  max: { orient: 1.18, reason: 2.1, change: 1.22, verify: 1.28, deliver: 1.06 },
};

const EFFORT_INDEX: Record<Effort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

const REPO_STAGE_WEIGHTS: Record<StageName, number> = {
  orient: 1,
  reason: 0.45,
  change: 0.25,
  verify: 0.35,
  deliver: 0.08,
};

const SIGNAL_ADDITIONS: Record<
  'external' | 'tests' | 'browser' | 'deploy' | 'destructive',
  Record<StageName, number>
> = {
  external: { orient: 1.5, reason: 3, change: 4, verify: 5, deliver: 1 },
  tests: { orient: 0.5, reason: 0.5, change: 2, verify: 6, deliver: 0.5 },
  browser: { orient: 1, reason: 0.5, change: 3, verify: 5, deliver: 0.5 },
  deploy: { orient: 0.5, reason: 0.5, change: 1.5, verify: 5, deliver: 8 },
  destructive: { orient: 1, reason: 2, change: 1, verify: 4, deliver: 1 },
};

const LOOP_INTERACTION_ADDITIONS: Record<StageName, number> = {
  orient: 0.25,
  reason: 0.75,
  change: 1.5,
  verify: 2,
  deliver: 0.8,
};

const DEFAULT_SEED = 0x41_45_54_41; // "AETA"; intentionally independent of prompt text.
const SIMULATION_COUNT = 1_600;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const roundMinute = (value: number): number => Math.round(value * 10) / 10;

const lerpFromOne = (factor: number, weight: number): number => 1 + (factor - 1) * weight;

const safeMetric = (value: number | undefined): number =>
  Number.isFinite(value) && (value ?? 0) > 0 ? (value ?? 0) : 0;

const repoPrior = (repo: RepoProfile | undefined): number => {
  if (!repo) return 1;
  const files = safeMetric(repo.fileCount);
  const lines = safeMetric(repo.linesOfCode);
  const tests = safeMetric(repo.testFileCount);
  const languages = safeMetric(repo.languageCount);
  const dependencies = safeMetric(repo.dependencyCount);
  const packages = safeMetric(repo.packageCount);
  const increment =
    0.034 * Math.log1p(files / 40) +
    0.017 * Math.log1p(lines / 5_000) +
    0.008 * Math.log1p(tests / 20) +
    0.01 * Math.log1p(languages) +
    0.009 * Math.log1p(dependencies / 20) +
    0.014 * Math.log1p(packages);
  return 1 + clamp(increment, 0, 0.24);
};

const modelProfile = (provider: EstimateInput['provider'], model: string): ModelProfile => {
  const name = model.trim().toLowerCase();
  if (/haiku|mini|spark|flash|nano|luna/.test(name)) {
    return { pace: 0.74, capability: 0.86, label: 'fast model tier' };
  }
  if (/fable|opus|ultra|gpt-5\.6-sol/.test(name)) {
    return { pace: 1.16, capability: 1.08, label: 'deep model tier' };
  }
  if (/sonnet|terra/.test(name)) {
    return { pace: 0.93, capability: 1.01, label: 'balanced model tier' };
  }
  if (/gpt-5\.6|gpt-5\.5|codex/.test(name)) {
    return { pace: 0.9, capability: 1.03, label: 'agentic model tier' };
  }
  if (/gpt-5|claude/.test(name)) {
    return { pace: 0.97, capability: 1, label: 'general model tier' };
  }
  return {
    pace: provider === 'codex' ? 0.96 : 1,
    capability: 1,
    label: 'unknown model neutral prior',
  };
};

const hashSeed = (seed: string | number | undefined): number => {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  if (typeof seed !== 'string') return DEFAULT_SEED;
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

const createRandom = (initialSeed: number): (() => number) => {
  let state = initialSeed || 0x6d_2b_79_f5;
  return () => {
    state += 0x6d_2b_79_f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const normal = (random: () => number): number => {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};

const percentile = (sorted: readonly number[], probability: number): number => {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
};

const summarize = (values: readonly number[]): DurationQuantiles => {
  const sorted = [...values].sort((a, b) => a - b);
  const expected = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    p25: roundMinute(percentile(sorted, 0.25)),
    p50: roundMinute(percentile(sorted, 0.5)),
    p80: roundMinute(percentile(sorted, 0.8)),
    p95: roundMinute(percentile(sorted, 0.95)),
    expected: roundMinute(expected),
  };
};

const resolveAnalysis = (input: EstimateInput): PromptAnalysis => {
  const inferred = analyzePrompt(input.prompt);
  const options = input.options;
  const signals = {
    external: options?.external ?? inferred.signals.external,
    tests: options?.tests ?? inferred.signals.tests,
    browser: options?.browser ?? inferred.signals.browser,
    deploy: options?.deploy ?? inferred.signals.deploy,
    destructive: options?.destructive ?? inferred.signals.destructive,
  };
  const taskClass = input.taskClass ?? inferred.taskClass;
  const scope = options?.scope ?? inferred.scope;
  const ambiguity = options?.ambiguity ?? inferred.ambiguity;
  const scopeScore: Record<ScopeLevel, number> = {
    micro: 0,
    small: 1,
    medium: 2,
    large: 3,
    project: 4,
  };
  const ambiguityScore: Record<AmbiguityLevel, number> = {
    low: 0.2,
    medium: 0.5,
    high: 0.82,
  };
  const drivers = [`${taskClass} task`, `${scope} scope`, `${ambiguity} ambiguity`];
  if (signals.external) drivers.push('external dependency');
  if (signals.tests) drivers.push('test verification');
  if (signals.browser) drivers.push('browser verification');
  if (signals.deploy) drivers.push('deployment');
  if (signals.destructive) drivers.push('destructive-operation safeguards');

  return {
    ...inferred,
    taskClass,
    scope,
    scopeScore: options?.scope ? scopeScore[scope] : inferred.scopeScore,
    ambiguity,
    ambiguityScore: options?.ambiguity ? ambiguityScore[ambiguity] : inferred.ambiguityScore,
    signals,
    drivers,
  };
};

const stageCenters = (
  input: EstimateInput,
  analysis: PromptAnalysis,
  calibrationMultiplier: number,
): { centers: Record<StageName, number>; drivers: Record<StageName, string[]>; model: ModelProfile } => {
  const model = modelProfile(input.provider, input.model);
  const prior = repoPrior(input.repo);
  const scopeFactor = SCOPE_FACTORS[analysis.scope];
  const ambiguityFactor = AMBIGUITY_FACTORS[analysis.ambiguity];
  const expectedFiles = safeMetric(input.options?.expectedFiles);
  const fileFactor = expectedFiles > 0 ? 1 + clamp(0.08 * Math.log1p(expectedFiles), 0, 0.34) : 1;
  const complexity = clamp(
    (SCOPE_FACTORS[analysis.scope] - 0.5) / 1.85 + analysis.ambiguityScore * 0.25,
    0,
    1.25,
  );
  const capabilityFactor = 1 + Math.max(0, 1 - model.capability) * complexity * 0.55;
  const providerFactors: Record<EstimateInput['provider'], Record<StageName, number>> = {
    codex: { orient: 0.96, reason: 1, change: 0.95, verify: 0.98, deliver: 1 },
    claude: { orient: 1, reason: 0.97, change: 1, verify: 1, deliver: 0.98 },
  };
  const operationalLoopCount = [
    analysis.signals.external,
    analysis.signals.tests,
    analysis.signals.browser,
    analysis.signals.deploy,
  ].filter(Boolean).length;
  const loopPairs = Math.max(0, (operationalLoopCount * (operationalLoopCount - 1)) / 2);

  const centers = {} as Record<StageName, number>;
  const drivers = {} as Record<StageName, string[]>;

  for (const definition of STAGES) {
    const stage = definition.stage;
    let minutes = BASE_MINUTES[analysis.taskClass][stage];
    const stageDrivers: string[] = [`${analysis.taskClass} baseline`];

    minutes *= lerpFromOne(scopeFactor, SCOPE_STAGE_WEIGHTS[stage]);
    stageDrivers.push(`${analysis.scope} scope`);

    minutes *= lerpFromOne(ambiguityFactor, AMBIGUITY_STAGE_WEIGHTS[stage]);
    if (analysis.ambiguity !== 'medium') stageDrivers.push(`${analysis.ambiguity} ambiguity`);

    minutes *= EFFORT_FACTORS[input.effort][stage];
    if (input.effort !== 'medium') stageDrivers.push(`${input.effort} reasoning effort`);

    minutes *= lerpFromOne(prior, REPO_STAGE_WEIGHTS[stage]);
    if (prior > 1.01 && REPO_STAGE_WEIGHTS[stage] >= 0.25) stageDrivers.push('repository prior');

    minutes *= lerpFromOne(fileFactor, stage === 'change' ? 1 : 0.35);
    minutes *= providerFactors[input.provider][stage];

    if (definition.modelBound) {
      minutes *= model.pace * capabilityFactor;
      stageDrivers.push(model.label);
      if (input.speed === 'fast') {
        // More deliberate effort and already-fast models leave less work for fast mode to compress.
        const fastFactor = clamp(
          0.64 + (1 - model.pace) * 0.2 + EFFORT_INDEX[input.effort] * 0.035,
          0.66,
          0.82,
        );
        minutes *= fastFactor;
        stageDrivers.push('fast mode');
      }
    }

    for (const signal of ['external', 'tests', 'browser', 'deploy', 'destructive'] as const) {
      if (!analysis.signals[signal]) continue;
      minutes += SIGNAL_ADDITIONS[signal][stage];
      if (SIGNAL_ADDITIONS[signal][stage] >= 1) stageDrivers.push(signal);
    }

    if (loopPairs > 0) {
      minutes += LOOP_INTERACTION_ADDITIONS[stage] * loopPairs;
      if (LOOP_INTERACTION_ADDITIONS[stage] * loopPairs >= 1) stageDrivers.push('feedback-loop interaction');
    }

    minutes *= calibrationMultiplier;
    if (Math.abs(calibrationMultiplier - 1) >= 0.005) stageDrivers.push('personal calibration');
    centers[stage] = Math.max(0.2, minutes);
    drivers[stage] = stageDrivers;
  }

  return { centers, drivers, model };
};

const simulationSigma = (analysis: PromptAnalysis, dispersionMultiplier: number): number => {
  const base: Record<AmbiguityLevel, number> = { low: 0.22, medium: 0.34, high: 0.5 };
  let sigma = base[analysis.ambiguity];
  if (analysis.signals.external) sigma += 0.06;
  if (analysis.taskClass === 'research' || analysis.taskClass === 'diagnose') sigma += 0.035;
  return sigma * dispersionMultiplier;
};

const surpriseProbability = (analysis: PromptAnalysis): number => {
  const ambiguityBase: Record<AmbiguityLevel, number> = { low: 0.045, medium: 0.13, high: 0.24 };
  let probability = ambiguityBase[analysis.ambiguity];
  if (analysis.signals.external) probability += 0.07;
  if (analysis.signals.deploy) probability += 0.04;
  if (analysis.signals.destructive) probability += 0.035;
  if (analysis.taskClass === 'diagnose') probability += 0.035;
  if (analysis.taskClass === 'migration') probability += 0.045;
  return clamp(probability, 0.04, 0.42);
};

const SURPRISE_STAGE_WEIGHTS: Record<StageName, number> = {
  orient: 0.45,
  reason: 0.9,
  change: 1,
  verify: 1.15,
  deliver: 0.35,
};

const adjustedQuantiles = (
  minutes: DurationQuantiles,
  calibration: EstimateResult['calibration'],
): DurationQuantiles => {
  const centerMultiplier = Math.max(0.01, calibration.quantileMultipliers.p50);
  const p80 = Math.max(
    minutes.p50,
    roundMinute(minutes.p80 * calibration.quantileMultipliers.p80 / centerMultiplier),
  );
  const p95 = Math.max(
    p80,
    roundMinute(minutes.p95 * calibration.quantileMultipliers.p95 / centerMultiplier),
  );
  return { ...minutes, p80, p95 };
};

const totalCenter = (
  input: EstimateInput,
  analysis: PromptAnalysis,
  calibrationMultiplier: number,
): number => Object.values(stageCenters(input, analysis, calibrationMultiplier).centers)
  .reduce((sum, value) => sum + value, 0);

const rankedDrivers = (
  input: EstimateInput,
  analysis: PromptAnalysis,
  centers: Record<StageName, number>,
  calibration: EstimateResult['calibration'],
): EstimateDriver[] => {
  const current = Object.values(centers).reduce((sum, value) => sum + value, 0);
  const drivers: EstimateDriver[] = [];
  const addImpact = (label: string, detail: string, counterfactual: number): void => {
    const impactMinutes = roundMinute(current - counterfactual);
    if (Math.abs(impactMinutes) < 0.5) return;
    drivers.push({ label, detail, impactMinutes });
  };

  if (analysis.scope !== 'medium') {
    addImpact(
      `${analysis.scope} scope`,
      'Change surface versus a medium task',
      totalCenter(input, { ...analysis, scope: 'medium' }, calibration.multiplier),
    );
  }
  if (analysis.ambiguity !== 'medium') {
    addImpact(
      `${analysis.ambiguity} ambiguity`,
      analysis.ambiguity === 'high' ? 'Unknowns also widen the tail' : 'Clearer constraints reduce rework',
      totalCenter(input, { ...analysis, ambiguity: 'medium', ambiguityScore: 0.5 }, calibration.multiplier),
    );
  }

  const signalLabels: Record<keyof PromptAnalysis['signals'], [string, string]> = {
    external: ['external dependency', 'Network and service feedback'],
    tests: ['test verification', 'Automated validation loop'],
    browser: ['browser verification', 'Rendered-flow validation'],
    deploy: ['production deployment', 'Build, release, and readback'],
    destructive: ['safety safeguards', 'Extra checks before mutation'],
  };
  for (const signal of Object.keys(signalLabels) as Array<keyof PromptAnalysis['signals']>) {
    if (!analysis.signals[signal]) continue;
    const [label, detail] = signalLabels[signal];
    addImpact(
      label,
      detail,
      totalCenter(
        input,
        { ...analysis, signals: { ...analysis.signals, [signal]: false } },
        calibration.multiplier,
      ),
    );
  }

  if (input.effort !== 'medium') {
    addImpact(
      `${input.effort} reasoning effort`,
      'Deliberation versus medium effort',
      totalCenter({ ...input, effort: 'medium' }, analysis, calibration.multiplier),
    );
  }
  if (input.speed === 'fast') {
    addImpact(
      'fast mode',
      'Only model-bound stages accelerate',
      totalCenter({ ...input, speed: 'standard' }, analysis, calibration.multiplier),
    );
  }
  if (input.repo && repoPrior(input.repo) > 1.01) {
    const { repo: _repo, ...withoutRepo } = input;
    addImpact(
      'repository shape',
      'Weak orientation prior, not task complexity',
      totalCenter(withoutRepo, analysis, calibration.multiplier),
    );
  }
  if (Math.abs(calibration.multiplier - 1) >= 0.005) {
    addImpact(
      'personal history',
      `${calibration.effectiveSampleCount} effective similar runs`,
      totalCenter(input, analysis, 1),
    );
  }

  drivers.sort((first, second) => Math.abs(second.impactMinutes ?? 0) - Math.abs(first.impactMinutes ?? 0));
  drivers.push({
    label: `${analysis.taskClass} reference class`,
    detail: 'Stage pattern for this kind of task',
  });
  return drivers;
};

const confidenceFor = (
  analysis: PromptAnalysis,
  minutes: DurationQuantiles,
  calibrationSamples: number,
): EstimateResult['confidence'] => {
  const spread = Math.round((minutes.p95 / Math.max(0.1, minutes.p50)) * 100) / 100;
  if (
    analysis.ambiguity === 'low' &&
    !analysis.signals.external &&
    (!analysis.signals.deploy || calibrationSamples >= 8)
  ) {
    return {
      level: 'high',
      spread,
      reason: calibrationSamples >= 8 ? 'Clear scope with personal history' : 'Clear, local scope',
    };
  }
  if (analysis.ambiguity === 'high' || (analysis.signals.external && analysis.signals.deploy)) {
    return {
      level: 'low',
      spread,
      reason: analysis.ambiguity === 'high' ? 'Requirements remain ambiguous' : 'External release path',
    };
  }
  return {
    level: 'medium',
    spread,
    reason: calibrationSamples > 0 ? 'Some personal history available' : 'Heuristic baseline',
  };
};

export const formatDuration = (minutes: number): string => {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  if (minutes < 1) return '<1 min';
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  if (rounded < 1_440) {
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
  }
  const days = Math.floor(rounded / 1_440);
  const remainingHours = Math.round((rounded % 1_440) / 60);
  if (remainingHours === 24) return `${days + 1} day${days + 1 === 1 ? '' : 's'}`;
  return remainingHours === 0 ? `${days} day${days === 1 ? '' : 's'}` : `${days}d ${remainingHours} hr`;
};

/**
 * Returns a deterministic distribution, not a single false-precision ETA.
 * Nothing is persisted and the prompt is not copied into the result or seed.
 */
export const estimateTask = (input: EstimateInput): EstimateResult => {
  const analysis = resolveAnalysis(input);
  const calibration = calibrate(input.calibrationSamples ?? [], input);
  const { centers, drivers: stageDrivers } = stageCenters(
    input,
    analysis,
    calibration.multiplier,
  );
  const resolvedSeed = hashSeed(input.seed);
  const random = createRandom(resolvedSeed);
  const sigma = simulationSigma(analysis, calibration.dispersionMultiplier);
  const tailProbability = surpriseProbability(analysis);
  const valuesByStage: Record<StageName, number[]> = {
    orient: [],
    reason: [],
    change: [],
    verify: [],
    deliver: [],
  };
  const totals: number[] = [];

  for (let simulation = 0; simulation < SIMULATION_COUNT; simulation += 1) {
    const sharedShock = normal(random);
    const surprise = random() < tailProbability;
    const surpriseMagnitude = surprise ? 0.22 + Math.abs(normal(random)) * 0.34 : 0;
    let total = 0;
    for (const definition of STAGES) {
      const stageShock = normal(random);
      const stageSigma =
        sigma *
        (definition.stage === 'reason' ? 1.08 : definition.stage === 'deliver' ? 0.82 : 1);
      const combinedShock = sharedShock * 0.48 + stageShock * 0.877;
      const sampled = centers[definition.stage] *
        Math.exp(combinedShock * stageSigma) *
        (1 + surpriseMagnitude * SURPRISE_STAGE_WEIGHTS[definition.stage]);
      valuesByStage[definition.stage].push(sampled);
      total += sampled;
    }
    totals.push(total);
  }

  const minutes = adjustedQuantiles(summarize(totals), calibration);
  const stages: StageEstimate[] = STAGES.map((definition) => {
    const stageMinutes = summarize(valuesByStage[definition.stage]);
    return {
      ...definition,
      minutes: stageMinutes,
      shareOfP50: Math.round((stageMinutes.p50 / Math.max(0.1, minutes.p50)) * 1_000) / 1_000,
      drivers: stageDrivers[definition.stage],
    };
  });

  const drivers = rankedDrivers(input, analysis, centers, calibration);

  const assumptions: string[] = [];
  if (!input.repo || Object.values(input.repo).every((value) => !safeMetric(value))) {
    assumptions.push('Repository size not supplied; neutral repository prior used.');
  }
  if (!analysis.signals.tests) assumptions.push('No explicit test run included.');
  if (!analysis.signals.deploy) assumptions.push('No production deployment included.');
  if (!calibration.applied) assumptions.push('No material personal calibration available.');
  if (calibration.excludedSampleCount > 0) {
    assumptions.push(`${calibration.excludedSampleCount} implausible stop ${calibration.excludedSampleCount === 1 ? 'boundary was' : 'boundaries were'} excluded from learning.`);
  }

  return {
    minutes,
    formatted: {
      p25: formatDuration(minutes.p25),
      p50: formatDuration(minutes.p50),
      p80: formatDuration(minutes.p80),
      p95: formatDuration(minutes.p95),
      expected: formatDuration(minutes.expected),
    },
    stages,
    analysis,
    confidence: confidenceFor(analysis, minutes, Math.floor(calibration.effectiveSampleCount)),
    drivers,
    assumptions,
    calibration,
    seed: resolvedSeed,
  };
};
