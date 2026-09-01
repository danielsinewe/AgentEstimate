import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolvePluginDataDir } from './store.js';
import type { RunHistoryEntry } from './types.js';

const CONNECTION_PREFIX = 'agent-eta-v1.';
const CONFIG_FILENAME = 'cloud-sync.json';
const STATE_FILENAME = 'cloud-sync-state.json';
const DATABASE_SCHEMA = 'project_agent_eta_v2';
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_TRACKED_RUNS = 10_000;
const DEFAULT_BATCH_SIZE = 50;

export interface CloudSyncConnection {
  version: 1;
  url: string;
  publishableKey: string;
  token: string;
}

interface CloudSyncState {
  version: 1;
  syncedRunIds: string[];
  lastSuccessAt?: string;
  lastError?: string;
}

export interface CloudSyncOptions {
  dataDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBatches?: number;
}

export interface CloudSyncResult {
  configured: boolean;
  pending: number;
  synced: number;
  lastSuccessAt?: string;
  error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return (parsed.protocol === 'https:' || (local && parsed.protocol === 'http:'))
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function validConnection(value: unknown): value is CloudSyncConnection {
  if (!isObject(value)) return false;
  return value.version === 1
    && safeUrl(value.url)
    && typeof value.publishableKey === 'string'
    && value.publishableKey.length >= 20
    && value.publishableKey.length <= 4096
    && value.publishableKey.trim() === value.publishableKey
    && !/\s/u.test(value.publishableKey)
    && typeof value.token === 'string'
    && /^aet_[a-f0-9]{64}$/u.test(value.token)
    && Object.keys(value).every((key) => ['version', 'url', 'publishableKey', 'token'].includes(key));
}

function validState(value: unknown): value is CloudSyncState {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.syncedRunIds)) return false;
  return value.syncedRunIds.length <= MAX_TRACKED_RUNS
    && value.syncedRunIds.every((id) => typeof id === 'string' && /^[a-f0-9]{32}$/u.test(id))
    && (value.lastSuccessAt === undefined || typeof value.lastSuccessAt === 'string')
    && (value.lastError === undefined || typeof value.lastError === 'string');
}

async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  const contents = await readFile(path);
  if (contents.byteLength > maxBytes) throw new Error('Agent ETA cloud sync file is too large.');
  return JSON.parse(contents.toString('utf8')) as unknown;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const dataDir = dirname(path);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => undefined);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function paths(options: CloudSyncOptions) {
  const dataDir = resolvePluginDataDir({ dataDir: options.dataDir });
  return {
    config: join(dataDir, CONFIG_FILENAME),
    state: join(dataDir, STATE_FILENAME),
  };
}

async function readConnection(options: CloudSyncOptions): Promise<CloudSyncConnection | null> {
  try {
    const { config } = paths(options);
    const value = await readBoundedJson(config, MAX_CONFIG_BYTES);
    if (!validConnection(value)) throw new Error('Saved Agent ETA cloud connection is invalid.');
    await chmod(config, 0o600).catch(() => undefined);
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function readState(options: CloudSyncOptions): Promise<CloudSyncState> {
  try {
    const { state } = paths(options);
    const value = await readBoundedJson(state, MAX_STATE_BYTES);
    if (!validState(value)) throw new Error('Saved Agent ETA cloud sync state is invalid.');
    await chmod(state, 0o600).catch(() => undefined);
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { version: 1, syncedRunIds: [] };
    throw error;
  }
}

export function parseConnectionCode(code: string): CloudSyncConnection {
  const trimmed = code.trim();
  if (!trimmed.startsWith(CONNECTION_PREFIX)) throw new Error('Connection code is invalid.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(CONNECTION_PREFIX.length), 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('Connection code is invalid.');
  }
  if (!validConnection(parsed)) throw new Error('Connection code is invalid.');
  return parsed;
}

export function createConnectionCode(connection: CloudSyncConnection): string {
  if (!validConnection(connection)) throw new Error('Connection details are invalid.');
  return `${CONNECTION_PREFIX}${Buffer.from(JSON.stringify(connection)).toString('base64url')}`;
}

export async function saveCloudSyncConnection(code: string, options: CloudSyncOptions = {}): Promise<void> {
  const connection = parseConnectionCode(code);
  const { config, state } = paths(options);
  await writePrivateJson(config, connection);
  await writePrivateJson(state, { version: 1, syncedRunIds: [] } satisfies CloudSyncState);
}

export async function disconnectCloudSync(options: CloudSyncOptions = {}): Promise<boolean> {
  const { config, state } = paths(options);
  const results = await Promise.allSettled([unlink(config), unlink(state)]);
  return results.some((result) => result.status === 'fulfilled');
}

function toCloudRun(entry: RunHistoryEntry & { elapsedMs: number; outcome: NonNullable<RunHistoryEntry['outcome']> }) {
  const prompt = entry.features.prompt;
  const repo = entry.features.repo;
  return {
    client_run_id: entry.runId,
    provider: entry.features.provider,
    model: entry.features.model,
    effort: entry.features.effort,
    speed: entry.features.speed,
    task_class: prompt.taskClass,
    scope: prompt.scope,
    ambiguity: prompt.ambiguity,
    included_tests: prompt.tests,
    included_browser: prompt.browser,
    included_external_services: prompt.external,
    included_deploy: prompt.deploy,
    destructive: prompt.destructive,
    prompt_characters: prompt.characters,
    prompt_words: prompt.words,
    prompt_lines: prompt.lines,
    prompt_checklist_items: prompt.checklistItems,
    repo_file_count: repo.fileCount,
    repo_lines_of_code: repo.linesOfCode,
    repo_test_file_count: repo.testFileCount,
    repo_language_count: repo.languageCount,
    repo_dependency_count: repo.dependencyCount,
    repo_package_count: repo.packageCount,
    repo_dirty_file_count: repo.dirtyFileCount,
    forecast_p25_minutes: Math.max(0.001, entry.estimate.minutes.p25),
    forecast_p50_minutes: Math.max(0.001, entry.estimate.minutes.p50),
    forecast_p80_minutes: Math.max(0.001, entry.estimate.minutes.p80),
    forecast_p95_minutes: Math.max(0.001, entry.estimate.minutes.p95),
    actual_minutes: Math.max(0.001, entry.elapsedMs / 60_000),
    outcome: entry.outcome,
    client_created_at: entry.startedAt,
  };
}

function safeRemoteMessage(value: unknown): string {
  if (!isObject(value)) return 'Cloud sync was rejected.';
  const message = value.message;
  return typeof message === 'string' && message.length <= 240 ? message : 'Cloud sync was rejected.';
}

async function uploadBatch(
  connection: CloudSyncConnection,
  batch: ReturnType<typeof toCloudRun>[],
  options: CloudSyncOptions,
): Promise<{ runIds: string[]; syncedAt: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${connection.url}/rest/v1/rpc/sync_plugin_runs`, {
      method: 'POST',
      headers: {
        apikey: connection.publishableKey,
        'Content-Type': 'application/json',
        'Content-Profile': DATABASE_SCHEMA,
        'Accept-Profile': DATABASE_SCHEMA,
        'X-Client-Info': 'agent-eta-plugin/0.1',
      },
      body: JSON.stringify({ p_token: connection.token, p_runs: batch }),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(safeRemoteMessage(body));
    if (
      !isObject(body)
      || !Array.isArray(body.runIds)
      || typeof body.accepted !== 'number'
      || !Number.isInteger(body.accepted)
      || body.accepted < 0
      || body.accepted > batch.length
      || typeof body.syncedAt !== 'string'
    ) {
      throw new Error('Cloud sync returned an invalid response.');
    }
    const expected = batch.map((run) => run.client_run_id);
    const expectedSet = new Set(expected);
    if (!body.runIds.every((id) => typeof id === 'string' && expectedSet.has(id))) {
      throw new Error('Cloud sync returned an invalid response.');
    }
    // A successful transaction can legitimately return fewer changed ids when
    // the same run already exists as an explicit browser import. Every row in
    // the validated batch is still delivered and must leave the local outbox.
    return { runIds: expected, syncedAt: body.syncedAt };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncPendingRuns(
  history: readonly RunHistoryEntry[],
  options: CloudSyncOptions = {},
): Promise<CloudSyncResult> {
  const connection = await readConnection(options);
  if (!connection) return { configured: false, pending: 0, synced: 0 };
  const state = await readState(options);
  const alreadySynced = new Set(state.syncedRunIds);
  const eligible = history.filter(
    (entry): entry is RunHistoryEntry & { elapsedMs: number; outcome: NonNullable<RunHistoryEntry['outcome']> } =>
      entry.elapsedMs !== undefined && entry.outcome !== undefined,
  );
  const pending = eligible.filter((entry) => !alreadySynced.has(entry.runId));
  const initialPending = pending.length;
  const maxBatches = Math.max(1, options.maxBatches ?? Number.MAX_SAFE_INTEGER);
  let synced = 0;

  try {
    for (let start = 0, batchNumber = 0; start < pending.length && batchNumber < maxBatches; start += DEFAULT_BATCH_SIZE, batchNumber += 1) {
      const result = await uploadBatch(connection, pending.slice(start, start + DEFAULT_BATCH_SIZE).map(toCloudRun), options);
      for (const runId of result.runIds) alreadySynced.add(runId);
      synced += result.runIds.length;
      state.lastSuccessAt = result.syncedAt;
      delete state.lastError;
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message.slice(0, 240) : 'Cloud sync failed.';
  }

  state.syncedRunIds = [...alreadySynced].slice(-MAX_TRACKED_RUNS);
  await writePrivateJson(paths(options).state, state);
  return {
    configured: true,
    pending: Math.max(0, initialPending - synced),
    synced,
    ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
    ...(state.lastError ? { error: state.lastError } : {}),
  };
}

export async function cloudSyncStatus(
  history: readonly RunHistoryEntry[],
  options: CloudSyncOptions = {},
): Promise<CloudSyncResult> {
  const connection = await readConnection(options);
  if (!connection) return { configured: false, pending: 0, synced: 0 };
  const state = await readState(options);
  const synced = new Set(state.syncedRunIds);
  const pending = history.filter((entry) => entry.elapsedMs !== undefined && !synced.has(entry.runId)).length;
  return {
    configured: true,
    pending,
    synced: 0,
    ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
    ...(state.lastError ? { error: state.lastError } : {}),
  };
}
