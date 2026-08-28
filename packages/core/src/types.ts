export type Provider = 'codex' | 'claude';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type SpeedMode = 'standard' | 'fast';

export type TaskClass =
  | 'question'
  | 'research'
  | 'review'
  | 'diagnose'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'migration';

export type ScopeLevel = 'micro' | 'small' | 'medium' | 'large' | 'project';

export type AmbiguityLevel = 'low' | 'medium' | 'high';

export type StageName = 'orient' | 'reason' | 'change' | 'verify' | 'deliver';

/**
 * A deliberately small, provider-neutral description of a repository.
 * All fields are optional so callers may disclose only the information they
 * are comfortable sharing. Missing values receive a neutral prior.
 */
export interface RepoProfile {
  fileCount?: number;
  linesOfCode?: number;
  testFileCount?: number;
  languageCount?: number;
  dependencyCount?: number;
  packageCount?: number;
}

/** Explicit task facts override signals inferred from the prompt. */
export interface TaskOptions {
  scope?: ScopeLevel;
  ambiguity?: AmbiguityLevel;
  external?: boolean;
  tests?: boolean;
  browser?: boolean;
  deploy?: boolean;
  destructive?: boolean;
  expectedFiles?: number;
}

export interface CalibrationSample {
  /** The p50 estimate shown before the task started. */
  estimatedMinutes: number;
  /** Elapsed active time measured after the task finished. */
  actualMinutes: number;
  taskClass?: TaskClass;
  provider?: Provider;
  model?: string;
  effort?: Effort;
  speed?: SpeedMode;
}

export interface EstimateInput {
  prompt: string;
  provider: Provider;
  model: string;
  effort: Effort;
  speed: SpeedMode;
  repo?: RepoProfile;
  taskClass?: TaskClass;
  options?: TaskOptions;
  /** Optional caller-controlled seed for reproducible what-if simulations. */
  seed?: string | number;
  /** Samples are consumed in-memory and are never persisted by this package. */
  calibrationSamples?: readonly CalibrationSample[];
}

export interface PromptSignals {
  external: boolean;
  tests: boolean;
  browser: boolean;
  deploy: boolean;
  destructive: boolean;
}

export interface PromptAnalysis {
  taskClass: TaskClass;
  scope: ScopeLevel;
  scopeScore: number;
  ambiguity: AmbiguityLevel;
  ambiguityScore: number;
  signals: PromptSignals;
  wordCount: number;
  actionCount: number;
  /** Human-readable categories only; prompt fragments are never copied here. */
  drivers: readonly string[];
}

export interface DurationQuantiles {
  p25: number;
  p50: number;
  p80: number;
  p95: number;
  expected: number;
}

export interface FormattedDurationQuantiles {
  p25: string;
  p50: string;
  p80: string;
  p95: string;
  expected: string;
}

export interface StageEstimate {
  stage: StageName;
  label: string;
  modelBound: boolean;
  minutes: DurationQuantiles;
  shareOfP50: number;
  drivers: readonly string[];
}

export type CalibrationLevel =
  | 'none'
  | 'global'
  | 'provider'
  | 'task'
  | 'provider-task'
  | 'model-effort';

export interface CalibrationResult {
  multiplier: number;
  /** Robust residual-width adjustment, shrunk toward the cold-start spread. */
  dispersionMultiplier: number;
  sampleCount: number;
  matchedSampleCount: number;
  level: CalibrationLevel;
  applied: boolean;
  /** Fixed safety bounds used after robust outlier handling and shrinkage. */
  bounds: readonly [number, number];
}

export interface CalibrationContext {
  taskClass?: TaskClass;
  provider?: Provider;
  model?: string;
  effort?: Effort;
  speed?: SpeedMode;
}

export interface EstimateConfidence {
  level: 'low' | 'medium' | 'high';
  /** p95 / p50. Lower means a tighter estimate. */
  spread: number;
  reason: string;
}

export interface EstimateResult {
  minutes: DurationQuantiles;
  formatted: FormattedDurationQuantiles;
  stages: readonly StageEstimate[];
  analysis: PromptAnalysis;
  confidence: EstimateConfidence;
  drivers: readonly string[];
  assumptions: readonly string[];
  calibration: CalibrationResult;
  /** Resolved numeric seed. It is never derived from the prompt. */
  seed: number;
}
