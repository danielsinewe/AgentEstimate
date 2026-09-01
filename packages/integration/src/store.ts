import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type {
  CalibrationStatus,
  CompletedRunRecord,
  RunHistoryEntry,
  RunRecord,
  RepositoryProfile,
  StartedRunRecord,
  StoredEstimate,
  StoredRunFeatures,
} from './types.js';
import { calibrate, estimateTask, type CalibrationSample } from '@agent-eta/core';

const SCHEMA_VERSION = 1 as const;
const HISTORY_FILENAME = 'runs.jsonl';
const SALT_FILENAME = '.install-salt';
const SALT_LOCK_FILENAME = '.install-salt.lock';
const LOCK_FILENAME = '.runs.lock';
const PROFILE_DIRECTORY = 'profiles';
const LOCK_STALE_MS = 10_000;
const PROFILE_CACHE_MS = 10 * 60_000;
const SALT_BYTES = 32;
const MAX_HISTORY_LINE_LENGTH = 16 * 1024;
const MAX_MODEL_LENGTH = 80;
const MAX_FORMATTED_DURATION_LENGTH = 64;
const MAX_CONFIDENCE_REASON_LENGTH = 512;

const PROVIDERS = ['codex', 'claude'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const SPEEDS = ['standard', 'fast'] as const;
const TASK_CLASSES = ['question', 'research', 'review', 'diagnose', 'bugfix', 'feature', 'refactor', 'migration'] as const;
const SCOPES = ['micro', 'small', 'medium', 'large', 'project'] as const;
const AMBIGUITIES = ['low', 'medium', 'high'] as const;
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
const PRIVATE_KEY_PATTERN = /^[a-f0-9]{32}$/u;

export interface StoreOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface StartRunInput {
  sessionId: string;
  turnId?: string;
  repoIdentity: string;
  source?: StartedRunRecord['source'];
  startedAt?: Date;
  features: StoredRunFeatures;
  estimate: StoredEstimate;
  identityHint?: string;
}

export interface CompleteRunInput {
  sessionId: string;
  turnId?: string;
  completedAt?: Date;
  outcome: CompletedRunRecord['outcome'];
  completeAll?: boolean;
}

export interface ImportRunInput {
  identity: string;
  sessionIdentity: string;
  repoIdentity: string;
  startedAt: Date;
  completedAt: Date;
  outcome: CompletedRunRecord['outcome'];
  features: StoredRunFeatures;
  estimate: StoredEstimate;
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const current = sorted[middle];
  if (current === undefined) return null;
  if (sorted.length % 2 === 1) return current;
  const previous = sorted[middle - 1];
  return previous === undefined ? current : (current + previous) / 2;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isOneOf<T extends string>(value: unknown, allowedValues: readonly T[]): value is T {
  return typeof value === 'string' && allowedValues.some((candidate) => candidate === value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isPrivateKey(value: unknown): value is string {
  return typeof value === 'string' && PRIVATE_KEY_PATTERN.test(value);
}

function isCanonicalDate(value: unknown): value is string {
  if (!isBoundedString(value, 32)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isNonnegativeInteger(value: unknown): value is number {
  return isNonnegativeFiniteNumber(value) && Number.isSafeInteger(value);
}

function isStoredPrompt(value: unknown): value is StoredRunFeatures['prompt'] {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'characters', 'words', 'lines', 'checklistItems', 'taskClass', 'scope', 'ambiguity',
    'external', 'tests', 'browser', 'deploy', 'destructive',
  ])) return false;
  return isNonnegativeInteger(value.characters) &&
    isNonnegativeInteger(value.words) &&
    isNonnegativeInteger(value.lines) &&
    isNonnegativeInteger(value.checklistItems) &&
    isOneOf(value.taskClass, TASK_CLASSES) &&
    isOneOf(value.scope, SCOPES) &&
    isOneOf(value.ambiguity, AMBIGUITIES) &&
    typeof value.external === 'boolean' &&
    typeof value.tests === 'boolean' &&
    typeof value.browser === 'boolean' &&
    typeof value.deploy === 'boolean' &&
    typeof value.destructive === 'boolean';
}

function isStoredRepository(value: unknown): value is StoredRunFeatures['repo'] {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'fileCount', 'linesOfCode', 'testFileCount', 'languageCount', 'dependencyCount', 'packageCount', 'dirtyFileCount',
  ])) return false;
  return [
    value.fileCount,
    value.linesOfCode,
    value.testFileCount,
    value.languageCount,
    value.dependencyCount,
    value.packageCount,
    value.dirtyFileCount,
  ].every(isNonnegativeInteger);
}

function isStoredFeatures(value: unknown): value is StoredRunFeatures {
  if (!isObject(value) || !hasOnlyKeys(value, ['provider', 'model', 'effort', 'speed', 'prompt', 'repo'])) return false;
  return isOneOf(value.provider, PROVIDERS) &&
    isBoundedString(value.model, MAX_MODEL_LENGTH) &&
    isOneOf(value.effort, EFFORTS) &&
    isOneOf(value.speed, SPEEDS) &&
    isStoredPrompt(value.prompt) &&
    isStoredRepository(value.repo);
}

function isStoredEstimate(value: unknown): value is StoredEstimate {
  if (!isObject(value) || !hasOnlyKeys(value, ['minutes', 'baseline', 'formatted', 'confidence'])) return false;
  if (!isObject(value.minutes) || !hasOnlyKeys(value.minutes, ['p25', 'p50', 'p80', 'p95', 'expected'])) return false;
  if (Object.hasOwn(value, 'baseline')) {
    if (!isObject(value.baseline) || !hasOnlyKeys(value.baseline, ['p50', 'p80', 'p95'])) return false;
    const baseline = value.baseline;
    if (![baseline.p50, baseline.p80, baseline.p95].every(isNonnegativeFiniteNumber) ||
      (baseline.p50 as number) > (baseline.p80 as number) ||
      (baseline.p80 as number) > (baseline.p95 as number)) return false;
  }
  if (!isObject(value.formatted) || !hasOnlyKeys(value.formatted, ['p50', 'p80'])) return false;
  if (!isObject(value.confidence) || !hasOnlyKeys(value.confidence, ['level', 'spread', 'reason'])) return false;

  const { p25, p50, p80, p95, expected } = value.minutes;
  return [p25, p50, p80, p95, expected].every(isNonnegativeFiniteNumber) &&
    (p25 as number) <= (p50 as number) &&
    (p50 as number) <= (p80 as number) &&
    (p80 as number) <= (p95 as number) &&
    isBoundedString(value.formatted.p50, MAX_FORMATTED_DURATION_LENGTH) &&
    isBoundedString(value.formatted.p80, MAX_FORMATTED_DURATION_LENGTH) &&
    isOneOf(value.confidence.level, CONFIDENCE_LEVELS) &&
    isNonnegativeFiniteNumber(value.confidence.spread) &&
    isBoundedString(value.confidence.reason, MAX_CONFIDENCE_REASON_LENGTH);
}

function baselineMinutes(entry: RunHistoryEntry): NonNullable<StoredEstimate['baseline']> {
  if (entry.estimate.baseline) return entry.estimate.baseline;
  const prompt = entry.features.prompt;
  const baseline = estimateTask({
    prompt: '',
    provider: entry.features.provider,
    model: entry.features.model,
    effort: entry.features.effort,
    speed: entry.features.speed,
    taskClass: prompt.taskClass,
    options: {
      scope: prompt.scope,
      ambiguity: prompt.ambiguity,
      external: prompt.external,
      tests: prompt.tests,
      browser: prompt.browser,
      deploy: prompt.deploy,
      destructive: prompt.destructive,
    },
    repo: entry.features.repo,
  });
  return {
    p50: baseline.minutes.p50,
    p80: baseline.minutes.p80,
    p95: baseline.minutes.p95,
  };
}

function toCalibrationSample(
  entry: RunHistoryEntry & { elapsedMs: number; outcome: 'success' },
): CalibrationSample {
  const baseline = baselineMinutes(entry);
  return {
    estimatedMinutes: entry.estimate.minutes.p50,
    estimatedP80Minutes: entry.estimate.minutes.p80,
    estimatedP95Minutes: entry.estimate.minutes.p95,
    baselineP50Minutes: baseline.p50,
    baselineP80Minutes: baseline.p80,
    baselineP95Minutes: baseline.p95,
    actualMinutes: entry.elapsedMs / 60_000,
    taskClass: entry.features.prompt.taskClass,
    provider: entry.features.provider,
    model: entry.features.model,
    effort: entry.features.effort,
    speed: entry.features.speed,
  };
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION || !isPrivateKey(value.runId)) return false;
  if (value.kind === 'started') {
    if (!hasOnlyKeys(value, [
      'schemaVersion', 'kind', 'runId', 'sessionKey', 'turnKey', 'repoKey', 'source', 'startedAt', 'features', 'estimate',
    ])) return false;
    return isPrivateKey(value.sessionKey) &&
      (!Object.hasOwn(value, 'turnKey') || isPrivateKey(value.turnKey)) &&
      isPrivateKey(value.repoKey) &&
      isOneOf(value.source, ['hook', 'import'] as const) &&
      isCanonicalDate(value.startedAt) &&
      isStoredFeatures(value.features) &&
      isStoredEstimate(value.estimate);
  }
  if (value.kind === 'completed') {
    if (!hasOnlyKeys(value, ['schemaVersion', 'kind', 'runId', 'completedAt', 'elapsedMs', 'outcome'])) return false;
    return isCanonicalDate(value.completedAt) &&
      isNonnegativeInteger(value.elapsedMs) &&
      isOneOf(value.outcome, ['success', 'failed', 'censored'] as const);
  }
  return false;
}

function isCachedProfile(value: unknown): value is { savedAt: string; profile: Omit<RepositoryProfile, 'root'> } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { savedAt?: unknown; profile?: Partial<RepositoryProfile> };
  const profile = candidate.profile;
  if (!isCanonicalDate(candidate.savedAt) || !profile) return false;
  if (profile.source !== 'git' && profile.source !== 'filesystem') return false;
  return [
    profile.fileCount,
    profile.linesOfCode,
    profile.testFileCount,
    profile.languageCount,
    profile.dependencyCount,
    profile.packageCount,
    profile.dirtyFileCount,
    profile.sampledCodeFiles,
  ].every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0) &&
    typeof profile.truncated === 'boolean';
}

export function resolvePluginDataDir(options: StoreOptions = {}): string {
  if (options.dataDir) return resolve(options.dataDir);
  const env = options.env ?? process.env;
  const configured = env.AGENT_ETA_DATA_DIR ?? env.CODEX_PLUGIN_DATA ?? env.PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA;
  if (configured) return resolve(configured);
  const cwd = resolve(options.cwd ?? process.cwd());
  const parts = cwd.split(sep);
  const pluginsIndex = parts.lastIndexOf('plugins');
  if (
    pluginsIndex > 0 &&
    parts[pluginsIndex + 1] === 'cache' &&
    parts[pluginsIndex + 3] === 'agent-eta' &&
    parts[pluginsIndex + 2]
  ) {
    const codexHome = parts.slice(0, pluginsIndex).join(sep) || sep;
    return resolve(codexHome, 'plugins', 'data', `agent-eta-${parts[pluginsIndex + 2]}`);
  }
  const xdgData = env.XDG_DATA_HOME;
  return resolve(xdgData ? join(xdgData, 'agent-eta') : join(homedir(), '.agent-eta'));
}

export class CalibrationStore {
  readonly dataDir: string;
  readonly historyPath: string;
  private salt: Buffer | null = null;

  constructor(options: StoreOptions = {}) {
    this.dataDir = resolvePluginDataDir(options);
    this.historyPath = join(this.dataDir, HISTORY_FILENAME);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700).catch(() => undefined);
  }

  private async readValidSalt(path: string): Promise<Buffer | null> {
    try {
      const salt = await readFile(path);
      return salt.length === SALT_BYTES ? salt : null;
    } catch {
      return null;
    }
  }

  private async getSalt(): Promise<Buffer> {
    if (this.salt) return this.salt;
    await this.ensureDirectory();
    const saltPath = join(this.dataDir, SALT_FILENAME);
    const existing = await this.readValidSalt(saltPath);
    if (existing) {
      await chmod(saltPath, 0o600).catch(() => undefined);
      this.salt = existing;
      return existing;
    }

    const installed = await this.withFileLock(SALT_LOCK_FILENAME, 'Agent ETA salt store is busy', async () => {
      const winner = await this.readValidSalt(saltPath);
      if (winner) {
        await chmod(saltPath, 0o600).catch(() => undefined);
        return winner;
      }

      const candidate = randomBytes(SALT_BYTES);
      const temporaryPath = join(
        this.dataDir,
        `${SALT_FILENAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
      );
      try {
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
          await handle.writeFile(candidate);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporaryPath, saltPath);
        } catch {
          // Windows cannot replace an existing malformed file with rename.
          await unlink(saltPath).catch(() => undefined);
          await rename(temporaryPath, saltPath);
        }
        await chmod(saltPath, 0o600).catch(() => undefined);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }

      const published = await this.readValidSalt(saltPath);
      if (!published) throw new Error('Agent ETA could not initialize its private salt');
      return published;
    });
    this.salt = installed;
    return installed;
  }

  async privateKey(value: string): Promise<string> {
    const salt = await this.getSalt();
    return createHmac('sha256', salt).update(value).digest('hex').slice(0, 32);
  }

  async cachedRepositoryProfile(identity: string, maxAgeMs = PROFILE_CACHE_MS): Promise<RepositoryProfile | null> {
    const cacheKey = await this.privateKey(`profile:${identity}`);
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(this.dataDir, PROFILE_DIRECTORY, `${cacheKey}.json`), 'utf8'),
      );
      if (!isCachedProfile(parsed)) return null;
      if (Date.now() - Date.parse(parsed.savedAt) > maxAgeMs) return null;
      return { root: resolve(identity), ...parsed.profile };
    } catch {
      return null;
    }
  }

  async cacheRepositoryProfile(identity: string, profile: RepositoryProfile): Promise<void> {
    const cacheKey = await this.privateKey(`profile:${identity}`);
    const directory = join(this.dataDir, PROFILE_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const derivedProfile: Omit<RepositoryProfile, 'root'> = {
      source: profile.source,
      fileCount: profile.fileCount,
      linesOfCode: profile.linesOfCode,
      testFileCount: profile.testFileCount,
      languageCount: profile.languageCount,
      dependencyCount: profile.dependencyCount,
      packageCount: profile.packageCount,
      dirtyFileCount: profile.dirtyFileCount,
      sampledCodeFiles: profile.sampledCodeFiles,
      truncated: profile.truncated,
    };
    const path = join(directory, `${cacheKey}.json`);
    await writeFile(path, JSON.stringify({ savedAt: new Date().toISOString(), profile: derivedProfile }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(path, 0o600).catch(() => undefined);
  }

  private async append(record: RunRecord): Promise<void> {
    if (!isRunRecord(record)) throw new Error('Refusing to persist an invalid Agent ETA run record');
    await this.ensureDirectory();
    await appendFile(this.historyPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(this.historyPath, 0o600).catch(() => undefined);
  }

  async records(): Promise<RunRecord[]> {
    try {
      const contents = await readFile(this.historyPath, 'utf8');
      const records: RunRecord[] = [];
      for (const line of contents.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        if (line.length > MAX_HISTORY_LINE_LENGTH) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRunRecord(parsed)) records.push(parsed);
        } catch {
          // A partially written tail should not make hooks fail.
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  private async withFileLock<T>(filename: string, busyMessage: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lockPath = join(this.dataDir, filename);
    const deadline = Date.now() + 1_000;

    while (true) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.close();
        break;
      } catch {
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
        } catch {
          // The competing process may have released the lock already.
        }
        if (Date.now() >= deadline) throw new Error(busyMessage);
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }

    try {
      return await operation();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withFileLock(LOCK_FILENAME, 'Agent ETA store is busy', operation);
  }

  async startRun(input: StartRunInput): Promise<StartedRunRecord> {
    const startedAt = input.startedAt ?? new Date();
    const sessionKey = await this.privateKey(`session:${input.sessionId}`);
    const turnKey = input.turnId ? await this.privateKey(`turn:${input.sessionId}:${input.turnId}`) : undefined;
    const repoKey = await this.privateKey(`repo:${input.repoIdentity}`);
    const runIdentity = input.identityHint ?? [input.sessionId, input.turnId ?? '', startedAt.toISOString()].join(':');
    const runId = await this.privateKey(`run:${runIdentity}`);
    const record: StartedRunRecord = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'started',
      runId,
      sessionKey,
      ...(turnKey ? { turnKey } : {}),
      repoKey,
      source: input.source ?? 'hook',
      startedAt: startedAt.toISOString(),
      features: input.features,
      estimate: input.estimate,
    };

    await this.withLock(async () => {
      const records = await this.records();
      if (records.some((candidate) => candidate.kind === 'started' && candidate.runId === runId)) return;
      const completedIds = new Set(
        records.filter((candidate): candidate is CompletedRunRecord => candidate.kind === 'completed').map((candidate) => candidate.runId),
      );
      const abandoned = records.filter(
        (candidate): candidate is StartedRunRecord =>
          candidate.kind === 'started' && candidate.sessionKey === sessionKey && !completedIds.has(candidate.runId),
      );
      for (const previous of abandoned) {
        await this.append({
          schemaVersion: SCHEMA_VERSION,
          kind: 'completed',
          runId: previous.runId,
          completedAt: startedAt.toISOString(),
          elapsedMs: Math.max(0, startedAt.getTime() - Date.parse(previous.startedAt)),
          outcome: 'censored',
        });
      }
      await this.append(record);
    });
    return record;
  }

  async completeRun(input: CompleteRunInput): Promise<{ record: CompletedRunRecord | null; records: CompletedRunRecord[]; created: boolean }> {
    const sessionKey = await this.privateKey(`session:${input.sessionId}`);
    const turnKey = input.turnId ? await this.privateKey(`turn:${input.sessionId}:${input.turnId}`) : undefined;
    return this.withLock(async () => {
      const records = await this.records();
      const completedIds = new Set(
        records.filter((record): record is CompletedRunRecord => record.kind === 'completed').map((record) => record.runId),
      );
      const activeRuns = records.filter(
        (record): record is StartedRunRecord =>
          record.kind === 'started' &&
          record.sessionKey === sessionKey &&
          !completedIds.has(record.runId) &&
          (!turnKey || record.turnKey === turnKey),
      );
      const selected = input.completeAll ? activeRuns : activeRuns.slice(-1);
      if (selected.length === 0) return { record: null, records: [], created: false };
      const completedAt = input.completedAt ?? new Date();
      const completedRecords = selected.map<CompletedRunRecord>((active) => ({
        schemaVersion: SCHEMA_VERSION,
        kind: 'completed',
        runId: active.runId,
        completedAt: completedAt.toISOString(),
        elapsedMs: Math.max(0, completedAt.getTime() - Date.parse(active.startedAt)),
        outcome: input.outcome,
      }));
      for (const completedRecord of completedRecords) await this.append(completedRecord);
      return { record: completedRecords.at(-1) ?? null, records: completedRecords, created: true };
    });
  }

  async importRun(input: ImportRunInput): Promise<boolean> {
    const runId = await this.privateKey(`import:${input.identity}`);
    const started: StartedRunRecord = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'started',
      runId,
      sessionKey: await this.privateKey(`session:${input.sessionIdentity}`),
      repoKey: await this.privateKey(`repo:${input.repoIdentity}`),
      source: 'import',
      startedAt: input.startedAt.toISOString(),
      features: input.features,
      estimate: input.estimate,
    };
    const completed: CompletedRunRecord = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'completed',
      runId,
      completedAt: input.completedAt.toISOString(),
      elapsedMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
      outcome: input.outcome,
    };

    return this.withLock(async () => {
      const records = await this.records();
      if (records.some((record) => record.runId === runId)) return false;
      await this.append(started);
      await this.append(completed);
      return true;
    });
  }

  async history(limit = 50): Promise<RunHistoryEntry[]> {
    const records = await this.records();
    const completed = new Map(
      records
        .filter((record): record is CompletedRunRecord => record.kind === 'completed')
        .map((record) => [record.runId, record]),
    );
    return records
      .filter((record): record is StartedRunRecord => record.kind === 'started')
      .map((record) => {
        const outcome = completed.get(record.runId);
        return {
          runId: record.runId,
          repoKey: record.repoKey,
          source: record.source,
          startedAt: record.startedAt,
          completedAt: outcome?.completedAt,
          elapsedMs: outcome?.elapsedMs,
          outcome: outcome?.outcome,
          features: record.features,
          estimate: record.estimate,
        };
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, Math.max(0, limit));
  }

  async currentRun(options: { repoIdentity?: string; maxAgeMs?: number } = {}): Promise<RunHistoryEntry | null> {
    const history = await this.history(Number.MAX_SAFE_INTEGER);
    const repoKey = options.repoIdentity ? await this.privateKey(`repo:${options.repoIdentity}`) : null;
    const cutoff = Date.now() - (options.maxAgeMs ?? 24 * 60 * 60_000);
    return history.find(
      (entry) =>
        entry.completedAt === undefined &&
        Date.parse(entry.startedAt) >= cutoff &&
        (!repoKey || entry.repoKey === repoKey),
    ) ?? null;
  }

  async calibrationStatus(): Promise<CalibrationStatus> {
    const history = await this.history(Number.MAX_SAFE_INTEGER);
    const completed = history.filter(
      (entry): entry is RunHistoryEntry & { elapsedMs: number; outcome: NonNullable<RunHistoryEntry['outcome']> } =>
        entry.elapsedMs !== undefined && entry.outcome !== undefined,
    );
    const successful = completed.filter(
      (entry): entry is RunHistoryEntry & { elapsedMs: number; outcome: 'success' } => entry.outcome === 'success',
    );
    const calibrationSamples = successful.map(toCalibrationSample);
    const learningEvidence = calibrate(calibrationSamples, {});
    const eligibleCalibrationRuns = successful.length - learningEvidence.excludedSampleCount;
    const actualMinutes = successful.map((entry) => positiveFinite(entry.elapsedMs / 60_000));
    const absoluteErrors = successful.map((entry) => Math.abs(entry.elapsedMs / 60_000 - entry.estimate.minutes.p50));
    const signedErrors = successful.map((entry) => entry.estimate.minutes.p50 - entry.elapsedMs / 60_000);
    const coverage = (quantile: 'p50' | 'p80'): number | null => {
      if (successful.length === 0) return null;
      const inside = successful.filter((entry) => entry.elapsedMs / 60_000 <= entry.estimate.minutes[quantile]).length;
      return inside / successful.length;
    };

    const p50ObservedCoverage = round(coverage('p50'), 3);
    const p80ObservedCoverage = round(coverage('p80'), 3);
    const reliability = eligibleCalibrationRuns < 8
      ? 'unproven'
      : p50ObservedCoverage !== null && p50ObservedCoverage >= 0.35 && p50ObservedCoverage <= 0.65 &&
          p80ObservedCoverage !== null && p80ObservedCoverage >= 0.68 && p80ObservedCoverage <= 0.9
        ? 'calibrated'
        : 'recalibrating';

    return {
      state: eligibleCalibrationRuns >= 20 ? 'personalized' : eligibleCalibrationRuns >= 3 ? 'learning' : 'cold-start',
      reliability,
      startedRuns: history.length,
      completedRuns: completed.length,
      successfulRuns: successful.length,
      eligibleCalibrationRuns,
      excludedCalibrationRuns: learningEvidence.excludedSampleCount,
      failedRuns: completed.filter((entry) => entry.outcome === 'failed').length,
      censoredRuns: completed.filter((entry) => entry.outcome === 'censored').length,
      medianActualMinutes: round(median(actualMinutes)),
      medianAbsoluteErrorMinutes: round(median(absoluteErrors)),
      medianSignedErrorMinutes: round(median(signedErrors)),
      p50ObservedCoverage,
      p80ObservedCoverage,
    };
  }

  async calibrationSamples(limit = 200): Promise<CalibrationSample[]> {
    const history = await this.history(Number.MAX_SAFE_INTEGER);
    return history
      .filter(
        (entry): entry is RunHistoryEntry & { elapsedMs: number; outcome: 'success' } =>
          entry.elapsedMs !== undefined && entry.outcome === 'success',
      )
      .slice(0, Math.max(0, limit))
      .map(toCalibrationSample);
  }

  async privacyFingerprint(): Promise<string> {
    const records = await this.records();
    return createHash('sha256').update(JSON.stringify(records)).digest('hex');
  }
}

export async function ensurePrivateParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}
