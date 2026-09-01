import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { estimateTask } from '@agent-eta/core';
import {
  derivePromptFeatures,
  normalizeEffort,
  normalizeModel,
  toStoredEstimate,
  toStoredFeatures,
} from './privacy.js';
import { profileRepository } from './repo-profile.js';
import { CalibrationStore } from './store.js';
import type { AgentEffort, AgentProvider, RepositoryProfile } from './types.js';

const MAX_PROMPT_CHARACTERS = 100_000;
const MAX_IMPORT_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_HISTORY_FILE_BYTES = 512 * 1024 * 1024;
const MAX_HISTORY_LINE_BYTES = 2 * 1024 * 1024;

export interface HistoryImportOptions {
  provider?: AgentProvider | 'auto';
  cwd?: string;
  dataDir?: string;
  maxTurns?: number;
}

export interface HistoryImportResult {
  experimental: true;
  adapter: 'codex-jsonl' | 'claude-jsonl' | 'unknown-jsonl';
  parsedLines: number;
  invalidLines: number;
  candidateTurns: number;
  importedRuns: number;
  duplicateRuns: number;
  skippedRuns: number;
}

interface CandidateTurn {
  provider: AgentProvider;
  prompt: string;
  startedAt: Date;
  lastActivityAt: Date;
  model: string;
  effort: AgentEffort;
  outcome: 'success' | 'failed' | 'censored';
  ordinal: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function timestamp(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const text = string(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function rowTimestamp(row: Record<string, unknown>): Date | null {
  const payload = object(row.payload);
  return timestamp(row.timestamp ?? row.created_at ?? row.createdAt ?? payload?.timestamp);
}

function textContent(value: unknown): string | null {
  const direct = string(value);
  if (direct) return direct;
  if (!Array.isArray(value)) return null;
  const pieces: string[] = [];
  for (const item of value) {
    const content = object(item);
    if (!content) continue;
    const type = string(content.type);
    if (type && !['text', 'input_text'].includes(type)) continue;
    const text = string(content.text ?? content.input_text);
    if (text) pieces.push(text);
  }
  return pieces.length > 0 ? pieces.join('\n') : null;
}

function codexPrompt(row: Record<string, unknown>): string | null {
  const payload = object(row.payload);
  const item = object(row.item);
  const payloadContent = payload ? textContent(payload.content) : null;
  const itemContent = item ? textContent(item.content) : null;
  if (payload?.type === 'user_message') return string(payload.message) ?? payloadContent;
  if (row.type === 'user_message') return string(row.message) ?? textContent(row.content);
  if ((payload?.role === 'user' || item?.role === 'user') && (payloadContent || itemContent)) return payloadContent ?? itemContent;
  if (row.type === 'turn.started' || row.type === 'turn_started') return string(row.prompt ?? row.input);
  return null;
}

function claudePrompt(row: Record<string, unknown>): string | null {
  if (row.type !== 'user' || row.isMeta === true) return null;
  const message = object(row.message);
  if (message && message.role !== 'user') return null;
  return textContent(message?.content ?? row.content);
}

function detectProvider(row: Record<string, unknown>): AgentProvider | null {
  if (
    row.type === 'session_meta' ||
    row.type === 'event_msg' ||
    row.type === 'response_item' ||
    row.type === 'turn_context' ||
    row.type === 'user_message' ||
    row.type === 'turn.started' ||
    row.type === 'turn_started' ||
    row.type === 'turn.completed' ||
    row.type === 'turn_completed'
  ) {
    return 'codex';
  }
  if (row.type === 'user' || row.type === 'assistant' || row.type === 'system') return 'claude';
  const model = string(row.model ?? object(row.payload)?.model);
  return model?.toLowerCase().includes('claude') ? 'claude' : null;
}

function modelSignal(row: Record<string, unknown>): string | null {
  const payload = object(row.payload);
  const message = object(row.message);
  return string(row.model ?? payload?.model ?? message?.model);
}

function effortSignal(row: Record<string, unknown>): string | null {
  const payload = object(row.payload);
  return string(row.reasoning_effort ?? row.effort ?? payload?.reasoning_effort ?? payload?.effort);
}

function isAssistantActivity(row: Record<string, unknown>, provider: AgentProvider): boolean {
  if (provider === 'claude') return row.type === 'assistant';
  const payload = object(row.payload);
  const item = object(row.item);
  return payload?.role === 'assistant' || item?.role === 'assistant' || payload?.type === 'agent_message' || row.type === 'turn.completed';
}

function completionOutcome(row: Record<string, unknown>, provider: AgentProvider): 'success' | 'failed' | null {
  const payload = object(row.payload);
  const type = string(row.type);
  const payloadType = string(payload?.type);
  if (provider === 'codex') {
    if (type === 'turn.completed' || type === 'turn_completed' || payloadType === 'task_complete') return 'success';
    if (type === 'turn.failed' || type === 'error' || payloadType === 'turn_aborted' || payloadType === 'error') return 'failed';
  }
  if (provider === 'claude' && type === 'system') {
    if (row.subtype === 'turn_duration') return 'success';
    if (row.subtype === 'error') return 'failed';
  }
  return null;
}

function safeDuration(turn: CandidateTurn, end: Date): number | null {
  const elapsed = end.getTime() - turn.startedAt.getTime();
  return elapsed >= 1_000 && elapsed <= MAX_IMPORT_DURATION_MS ? elapsed : null;
}

function coreRepo(profile: RepositoryProfile) {
  return {
    fileCount: profile.fileCount,
    linesOfCode: profile.linesOfCode,
    testFileCount: profile.testFileCount,
    languageCount: profile.languageCount,
    dependencyCount: profile.dependencyCount,
    packageCount: profile.packageCount,
  };
}

async function* boundedJsonlLines(path: string): AsyncGenerator<string | null> {
  const file = await stat(path);
  if (file.size > MAX_HISTORY_FILE_BYTES) throw new Error('History file exceeds the 512 MB import limit');
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let pending = '';
  let pendingBytes = 0;
  let discarding = false;

  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      const end = newline >= 0 ? newline : chunk.length;
      const piece = chunk.slice(start, end);
      if (!discarding) {
        const pieceBytes = Buffer.byteLength(piece, 'utf8');
        if (pendingBytes + pieceBytes > MAX_HISTORY_LINE_BYTES) {
          pending = '';
          pendingBytes = 0;
          discarding = true;
        } else {
          pending += piece;
          pendingBytes += pieceBytes;
        }
      }
      if (newline >= 0) {
        if (discarding) yield null;
        else yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
        pending = '';
        pendingBytes = 0;
        discarding = false;
        start = newline + 1;
      } else {
        start = chunk.length;
      }
    }
  }
  if (discarding) yield null;
  else if (pending.length > 0) yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
}

export async function importHistoryFile(path: string, options: HistoryImportOptions = {}): Promise<HistoryImportResult> {
  const absolutePath = resolve(path);
  const preferredProvider = options.provider ?? 'auto';
  const cwd = resolve(options.cwd ?? process.cwd());
  const store = new CalibrationStore({ dataDir: options.dataDir });
  const repo = await profileRepository(cwd).catch<RepositoryProfile>(() => ({
    root: cwd,
    source: 'filesystem',
    fileCount: 0,
    linesOfCode: 0,
    testFileCount: 0,
    languageCount: 0,
    dependencyCount: 0,
    packageCount: 0,
    dirtyFileCount: 0,
    sampledCodeFiles: 0,
    truncated: false,
  }));
  const completed: CandidateTurn[] = [];
  let active: CandidateTurn | null = null;
  let provider: AgentProvider | null = preferredProvider === 'auto' ? null : preferredProvider;
  let parsedLines = 0;
  let invalidLines = 0;
  let ordinal = 0;
  let contextModel: string | null = null;
  let contextEffort: AgentEffort = 'medium';

  const finish = (end: Date, outcome?: CandidateTurn['outcome']) => {
    if (!active) return;
    if (safeDuration(active, end) !== null) completed.push({ ...active, lastActivityAt: end, outcome: outcome ?? active.outcome });
    active = null;
  };

  for await (const line of boundedJsonlLines(absolutePath)) {
    if (line === null) {
      invalidLines += 1;
      continue;
    }
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      const parsedObject = object(parsed);
      if (!parsedObject) throw new Error('JSONL row is not an object');
      row = parsedObject;
      parsedLines += 1;
    } catch {
      invalidLines += 1;
      continue;
    }

    provider ??= detectProvider(row);
    if (!provider) continue;
    const rowModel = modelSignal(row);
    const rowEffort = effortSignal(row);
    if (rowModel) contextModel = normalizeModel(rowModel, provider);
    if (rowEffort) contextEffort = normalizeEffort(rowEffort);
    if (active && rowModel) active.model = normalizeModel(rowModel, provider);
    if (active && rowEffort) active.effort = contextEffort;
    const at = rowTimestamp(row);
    const prompt = provider === 'codex' ? codexPrompt(row) : claudePrompt(row);

    if (prompt && at) {
      if (active) finish(active.lastActivityAt);
      ordinal += 1;
      active = {
        provider,
        prompt: prompt.slice(0, MAX_PROMPT_CHARACTERS),
        startedAt: at,
        lastActivityAt: at,
        model: contextModel ?? normalizeModel(undefined, provider),
        effort: contextEffort,
        outcome: 'censored',
        ordinal,
      };
      if (completed.length >= (options.maxTurns ?? 5_000)) break;
      continue;
    }

    if (!active) continue;
    if (at && isAssistantActivity(row, provider)) active.lastActivityAt = at;
    const outcome = completionOutcome(row, provider);
    if (outcome && at) finish(at, outcome);
  }
  if (active) finish(active.lastActivityAt);

  let importedRuns = 0;
  let duplicateRuns = 0;
  let skippedRuns = 0;
  for (const turn of completed) {
    const elapsedMs = safeDuration(turn, turn.lastActivityAt);
    if (elapsedMs === null) {
      skippedRuns += 1;
      continue;
    }
    const promptFeatures = derivePromptFeatures(turn.prompt);
    const estimate = estimateTask({
      prompt: turn.prompt,
      provider: turn.provider,
      model: turn.model,
      effort: turn.effort,
      speed: 'standard',
      repo: coreRepo(repo),
      taskClass: promptFeatures.taskClass,
      options: {
        scope: promptFeatures.scope,
        ambiguity: promptFeatures.ambiguity,
        external: promptFeatures.external,
        tests: promptFeatures.tests,
        browser: promptFeatures.browser,
        deploy: promptFeatures.deploy,
        destructive: promptFeatures.destructive,
      },
    });
    const imported = await store.importRun({
      identity: `${absolutePath}:${turn.ordinal}:${turn.startedAt.toISOString()}`,
      sessionIdentity: `${turn.provider}:import:${basename(absolutePath)}`,
      repoIdentity: repo.root,
      startedAt: turn.startedAt,
      completedAt: turn.lastActivityAt,
      outcome: turn.outcome,
      features: toStoredFeatures({
        provider: turn.provider,
        model: turn.model,
        effort: turn.effort,
        speed: 'standard',
        prompt: promptFeatures,
        repo,
      }),
      estimate: toStoredEstimate(estimate, estimate),
    });
    if (imported) importedRuns += 1;
    else duplicateRuns += 1;
  }

  return {
    experimental: true,
    adapter: provider === 'codex' ? 'codex-jsonl' : provider === 'claude' ? 'claude-jsonl' : 'unknown-jsonl',
    parsedLines,
    invalidLines,
    candidateTurns: completed.length,
    importedRuns,
    duplicateRuns,
    skippedRuns,
  };
}
