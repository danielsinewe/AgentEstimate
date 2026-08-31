import type {
  PrivateRunInsert,
  RunAmbiguity,
  RunEffort,
  RunOutcome,
  RunProvider,
  RunScope,
  RunSource,
  RunSpeed,
  RunTaskClass,
} from './types';

const PROVIDERS = ['codex', 'claude'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const SPEEDS = ['standard', 'fast'] as const;
const TASK_CLASSES = ['question', 'research', 'review', 'diagnose', 'bugfix', 'feature', 'refactor', 'migration'] as const;
const SCOPES = ['micro', 'small', 'medium', 'large', 'project'] as const;
const AMBIGUITIES = ['low', 'medium', 'high'] as const;
const OUTCOMES = ['started', 'success', 'failed', 'censored'] as const;
const MAX_DURATION_MINUTES = 5_256_000;
const CLIENT_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROHIBITED_INPUT_KEYS = new Set([
  'prompt',
  'rawPrompt',
  'repository',
  'repositoryName',
  'repositoryPath',
  'repoName',
  'repoPath',
  'repoRoot',
  'root',
  'cwd',
  'sourceCode',
]);

export interface LocalRunInput {
  id: string;
  provider: RunProvider;
  model: string;
  effort: RunEffort;
  speed: RunSpeed;
  taskClass: RunTaskClass;
  scope?: RunScope;
  ambiguity?: RunAmbiguity;
  tests?: boolean;
  browser?: boolean;
  external?: boolean;
  deploy?: boolean;
  destructive?: boolean;
  estimatedP25Minutes?: number;
  estimatedMinutes: number;
  estimatedP80Minutes?: number;
  estimatedP95Minutes?: number;
  actualMinutes?: number;
  successful?: boolean;
  outcome?: RunOutcome;
  createdAt: string;
}

export type RunValidationResult =
  | { ok: true; value: PrivateRunInsert }
  | { ok: false; error: string };

export type LocalRunValidationResult =
  | { ok: true; value: LocalRunInput }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function optionalOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T | undefined {
  return value === undefined || oneOf(value, allowed);
}

function positiveDuration(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= MAX_DURATION_MINUTES;
}

function optionalDuration(value: unknown): value is number | undefined {
  return value === undefined || positiveDuration(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function prohibitedKey(value: Record<string, unknown>): string | null {
  return Object.keys(value).find((key) => PROHIBITED_INPUT_KEYS.has(key)) ?? null;
}

function resolveOutcome(value: Record<string, unknown>): RunOutcome | null {
  if (value.outcome !== undefined) return oneOf(value.outcome, OUTCOMES) ? value.outcome : null;
  if (value.successful === undefined) return value.actualMinutes === undefined ? 'started' : 'success';
  if (typeof value.successful !== 'boolean') return null;
  return value.successful ? 'success' : 'failed';
}

/**
 * Converts an unknown local value into the exact cloud allowlist. Unsupported
 * values never reach Supabase, even if a caller accidentally passes a larger object.
 */
export function toPrivateRunInsert(
  input: unknown,
  userId: string,
  source: RunSource,
): RunValidationResult {
  if (!isRecord(input)) return { ok: false, error: 'Run data must be an object.' };
  const unsafeKey = prohibitedKey(input);
  if (unsafeKey) return { ok: false, error: `Run data contains prohibited field: ${unsafeKey}.` };

  const outcome = resolveOutcome(input);
  const clientRunId = input.id;
  if (typeof clientRunId !== 'string' || !CLIENT_RUN_ID_PATTERN.test(clientRunId)) {
    return { ok: false, error: 'Run id is missing or invalid.' };
  }
  if (!oneOf(input.provider, PROVIDERS)) return { ok: false, error: 'Provider is invalid.' };
  if (typeof input.model !== 'string'
      || input.model.length < 1
      || input.model.length > 80
      || input.model.trim() !== input.model
      || [...input.model].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) {
    return { ok: false, error: 'Model is invalid.' };
  }
  if (!oneOf(input.effort, EFFORTS)) return { ok: false, error: 'Effort is invalid.' };
  if (!oneOf(input.speed, SPEEDS)) return { ok: false, error: 'Speed is invalid.' };
  if (!oneOf(input.taskClass, TASK_CLASSES)) return { ok: false, error: 'Task class is invalid.' };
  if (!optionalOneOf(input.scope, SCOPES)) return { ok: false, error: 'Scope is invalid.' };
  if (!optionalOneOf(input.ambiguity, AMBIGUITIES)) return { ok: false, error: 'Ambiguity is invalid.' };
  if (![input.tests, input.browser, input.external, input.deploy, input.destructive].every(optionalBoolean)) {
    return { ok: false, error: 'Run flags must be booleans.' };
  }
  if (!optionalDuration(input.estimatedP25Minutes)
      || !positiveDuration(input.estimatedMinutes)
      || !optionalDuration(input.estimatedP80Minutes)
      || !optionalDuration(input.estimatedP95Minutes)
      || !optionalDuration(input.actualMinutes)) {
    return { ok: false, error: 'Run durations are invalid.' };
  }
  if (input.estimatedP25Minutes !== undefined && input.estimatedP25Minutes > input.estimatedMinutes) {
    return { ok: false, error: 'P25 cannot exceed P50.' };
  }
  if (input.estimatedP80Minutes !== undefined && input.estimatedP80Minutes < input.estimatedMinutes) {
    return { ok: false, error: 'P80 cannot be below P50.' };
  }
  if (input.estimatedP95Minutes !== undefined
      && input.estimatedP80Minutes !== undefined
      && input.estimatedP95Minutes < input.estimatedP80Minutes) {
    return { ok: false, error: 'P95 cannot be below P80.' };
  }
  if (!outcome) return { ok: false, error: 'Run outcome is invalid.' };
  if ((outcome === 'started') !== (input.actualMinutes === undefined)) {
    return { ok: false, error: 'Started runs must omit actual duration; completed runs must include it.' };
  }
  if (!canonicalTimestamp(input.createdAt)) return { ok: false, error: 'Run timestamp is invalid.' };
  if (typeof userId !== 'string' || !userId) return { ok: false, error: 'User id is missing.' };

  return {
    ok: true,
    value: {
      user_id: userId,
      client_run_id: clientRunId,
      schema_version: 1,
      source,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      speed: input.speed,
      task_class: input.taskClass,
      scope: input.scope ?? null,
      ambiguity: input.ambiguity ?? null,
      included_tests: input.tests === true,
      included_browser: input.browser === true,
      included_external_services: input.external === true,
      included_deploy: input.deploy === true,
      destructive: input.destructive === true,
      forecast_p25_minutes: input.estimatedP25Minutes ?? null,
      forecast_p50_minutes: input.estimatedMinutes,
      forecast_p80_minutes: input.estimatedP80Minutes ?? null,
      forecast_p95_minutes: input.estimatedP95Minutes ?? null,
      actual_minutes: input.actualMinutes ?? null,
      outcome,
      client_created_at: input.createdAt,
    },
  };
}

/**
 * Sanitizes browser-stored history before it can affect local calibration or
 * be shown in the account UI. The returned object contains only the same
 * derived fields accepted by the cloud allowlist.
 */
export function toLocalRunInput(input: unknown): LocalRunValidationResult {
  const parsed = toPrivateRunInsert(input, 'local-validation', 'web');
  if (!parsed.ok) return parsed;

  const row = parsed.value;
  const value: LocalRunInput = {
    id: row.client_run_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    speed: row.speed,
    taskClass: row.task_class,
    estimatedMinutes: row.forecast_p50_minutes,
    createdAt: row.client_created_at,
    outcome: row.outcome,
  };

  if (row.scope !== null && row.scope !== undefined) value.scope = row.scope;
  if (row.ambiguity !== null && row.ambiguity !== undefined) value.ambiguity = row.ambiguity;
  if (row.included_tests) value.tests = true;
  if (row.included_browser) value.browser = true;
  if (row.included_external_services) value.external = true;
  if (row.included_deploy) value.deploy = true;
  if (row.destructive) value.destructive = true;
  if (row.forecast_p25_minutes !== null && row.forecast_p25_minutes !== undefined) {
    value.estimatedP25Minutes = row.forecast_p25_minutes;
  }
  if (row.forecast_p80_minutes !== null && row.forecast_p80_minutes !== undefined) {
    value.estimatedP80Minutes = row.forecast_p80_minutes;
  }
  if (row.forecast_p95_minutes !== null && row.forecast_p95_minutes !== undefined) {
    value.estimatedP95Minutes = row.forecast_p95_minutes;
  }
  if (row.actual_minutes !== null && row.actual_minutes !== undefined) {
    value.actualMinutes = row.actual_minutes;
    value.successful = row.outcome === 'success';
  }

  return { ok: true, value };
}
