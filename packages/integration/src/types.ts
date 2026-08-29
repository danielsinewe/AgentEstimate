import type { EstimateResult } from '@agent-eta/core';

export type AgentProvider = 'codex' | 'claude';
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentSpeed = 'standard' | 'fast';
export type TaskClass =
  | 'question'
  | 'research'
  | 'review'
  | 'diagnose'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'migration';

export interface RepositoryProfile {
  root: string;
  source: 'git' | 'filesystem';
  fileCount: number;
  linesOfCode: number;
  testFileCount: number;
  languageCount: number;
  dependencyCount: number;
  packageCount: number;
  dirtyFileCount: number;
  sampledCodeFiles: number;
  truncated: boolean;
}

export interface DerivedPromptFeatures {
  characters: number;
  words: number;
  lines: number;
  checklistItems: number;
  taskClass: TaskClass;
  scope: 'micro' | 'small' | 'medium' | 'large' | 'project';
  ambiguity: 'low' | 'medium' | 'high';
  external: boolean;
  tests: boolean;
  browser: boolean;
  deploy: boolean;
  destructive: boolean;
}

export interface StoredRunFeatures {
  provider: AgentProvider;
  model: string;
  effort: AgentEffort;
  speed: AgentSpeed;
  prompt: DerivedPromptFeatures;
  repo: Omit<RepositoryProfile, 'root' | 'source' | 'dirtyFileCount' | 'sampledCodeFiles' | 'truncated'> & {
    dirtyFileCount: number;
  };
}

export interface StoredEstimate {
  minutes: Pick<EstimateResult['minutes'], 'p25' | 'p50' | 'p80' | 'p95' | 'expected'>;
  formatted: Pick<EstimateResult['formatted'], 'p50' | 'p80'>;
  confidence: EstimateResult['confidence'];
}

export interface StartedRunRecord {
  schemaVersion: 1;
  kind: 'started';
  runId: string;
  sessionKey: string;
  turnKey?: string;
  repoKey: string;
  source: 'hook' | 'import';
  startedAt: string;
  features: StoredRunFeatures;
  estimate: StoredEstimate;
}

export interface CompletedRunRecord {
  schemaVersion: 1;
  kind: 'completed';
  runId: string;
  completedAt: string;
  elapsedMs: number;
  outcome: 'success' | 'failed' | 'censored';
}

export type RunRecord = StartedRunRecord | CompletedRunRecord;

export interface RunHistoryEntry {
  runId: string;
  repoKey: string;
  source: StartedRunRecord['source'];
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  outcome?: CompletedRunRecord['outcome'];
  features: StoredRunFeatures;
  estimate: StoredEstimate;
}

export interface CalibrationStatus {
  state: 'cold-start' | 'learning' | 'personalized';
  startedRuns: number;
  completedRuns: number;
  successfulRuns: number;
  eligibleCalibrationRuns: number;
  excludedCalibrationRuns: number;
  failedRuns: number;
  censoredRuns: number;
  medianActualMinutes: number | null;
  medianAbsoluteErrorMinutes: number | null;
  p50ObservedCoverage: number | null;
  p80ObservedCoverage: number | null;
}

export interface HookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  turn_id?: unknown;
  turnId?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  model?: unknown;
  effort?: unknown;
  reasoning_effort?: unknown;
  speed?: unknown;
  service_tier?: unknown;
  [key: string]: unknown;
}

export type HookOutput = Record<string, unknown>;
