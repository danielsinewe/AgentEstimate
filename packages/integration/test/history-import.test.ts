import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importHistoryFile } from '../src/history-import.js';
import { CalibrationStore } from '../src/store.js';

function jsonl(rows: readonly (Record<string, unknown> | string)[]): string {
  return rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n');
}

describe('experimental history import', () => {
  it('imports a Codex turn, rejects malformed lines, deduplicates re-imports, and omits raw prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-codex-import-'));
    const dataDir = join(root, 'data');
    const transcript = join(root, 'codex.jsonl');
    const secret = 'PRIVATE-CODEX-PROMPT-93';
    await writeFile(
      transcript,
      jsonl([
        { type: 'session_meta', timestamp: '2026-08-28T10:00:00.000Z', payload: { id: 'session-raw' } },
        {
          type: 'response_item',
          timestamp: '2026-08-28T10:00:01.000Z',
          payload: { type: 'user_message', message: `Implement ${secret} and add tests.`, model: 'gpt-5.6-codex' },
          reasoning_effort: 'high',
        },
        'invalid-json',
        {
          type: 'response_item',
          timestamp: '2026-08-28T10:02:00.000Z',
          payload: { type: 'agent_message', message: 'done' },
        },
        { type: 'turn.completed', timestamp: '2026-08-28T10:02:31.000Z' },
      ]),
      'utf8',
    );

    const first = await importHistoryFile(transcript, { cwd: root, dataDir });
    expect(first).toEqual({
      experimental: true,
      adapter: 'codex-jsonl',
      parsedLines: 4,
      invalidLines: 1,
      candidateTurns: 1,
      importedRuns: 1,
      duplicateRuns: 0,
      skippedRuns: 0,
    });
    const second = await importHistoryFile(transcript, { cwd: root, dataDir });
    expect(second.importedRuns).toBe(0);
    expect(second.duplicateRuns).toBe(1);

    const store = new CalibrationStore({ dataDir });
    const history = await store.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      source: 'import',
      elapsedMs: 150_000,
      outcome: 'success',
      features: { provider: 'codex', effort: 'high', prompt: { taskClass: 'feature', tests: true } },
    });
    const rawStore = await readFile(store.historyPath, 'utf8');
    expect(rawStore).not.toContain(secret);
    expect(rawStore).not.toContain('session-raw');
    expect(rawStore).not.toContain(transcript);
  });

  it('auto-detects Claude JSONL and imports failed and successful turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-claude-import-'));
    const dataDir = join(root, 'data');
    const transcript = join(root, 'claude.jsonl');
    await writeFile(
      transcript,
      jsonl([
        {
          type: 'user',
          timestamp: '2026-08-28T10:00:00.000Z',
          model: 'claude-sonnet-4-6',
          effort: 'medium',
          message: { role: 'user', content: [{ type: 'text', text: 'Diagnose the API bug.' }] },
        },
        {
          type: 'assistant',
          timestamp: '2026-08-28T10:00:30.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Working' }] },
        },
        { type: 'system', subtype: 'error', timestamp: '2026-08-28T10:01:00.000Z' },
        {
          type: 'user',
          timestamp: '2026-08-28T10:02:00.000Z',
          message: { role: 'user', content: 'Review the patch.' },
        },
        { type: 'assistant', timestamp: '2026-08-28T10:02:45.000Z', message: { role: 'assistant', content: 'Done' } },
        { type: 'system', subtype: 'turn_duration', timestamp: '2026-08-28T10:03:00.000Z' },
      ]),
      'utf8',
    );

    const result = await importHistoryFile(transcript, { cwd: root, dataDir });
    expect(result.adapter).toBe('claude-jsonl');
    expect(result.candidateTurns).toBe(2);
    expect(result.importedRuns).toBe(2);
    const history = await new CalibrationStore({ dataDir }).history();
    expect(history.map((entry) => entry.outcome).sort()).toEqual(['failed', 'success']);
    expect(history.every((entry) => entry.features.provider === 'claude')).toBe(true);
  });

  it('returns an unknown adapter without writes when no provider can be detected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-unknown-import-'));
    const transcript = join(root, 'unknown.jsonl');
    await writeFile(transcript, jsonl([{ kind: 'unrelated', timestamp: '2026-08-28T10:00:00Z' }]), 'utf8');
    const result = await importHistoryFile(transcript, { cwd: root, dataDir: join(root, 'data') });
    expect(result).toMatchObject({ adapter: 'unknown-jsonl', candidateTurns: 0, importedRuns: 0 });
  });

  it('does not import durations outside the supported safety window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-duration-import-'));
    const transcript = join(root, 'unsafe.jsonl');
    await writeFile(
      transcript,
      jsonl([
        { type: 'user_message', timestamp: '2026-08-28T10:00:00.000Z', message: 'Fix it.' },
        { type: 'turn.completed', timestamp: '2026-08-28T10:00:00.500Z' },
        { type: 'user_message', timestamp: '2026-08-28T11:00:00.000Z', message: 'Fix another.' },
        { type: 'turn.completed', timestamp: '2026-09-05T11:00:00.000Z' },
      ]),
      'utf8',
    );
    const result = await importHistoryFile(transcript, { provider: 'codex', cwd: root, dataDir: join(root, 'data') });
    expect(result.candidateTurns).toBe(0);
    expect(result.importedRuns).toBe(0);
  });

  it('marks interrupted turns as censored so they never become calibration samples', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-censored-import-'));
    const dataDir = join(root, 'data');
    const transcript = join(root, 'interrupted.jsonl');
    await writeFile(
      transcript,
      jsonl([
        { type: 'user_message', timestamp: '2026-08-28T10:00:00.000Z', message: 'Implement the feature.' },
        { type: 'response_item', timestamp: '2026-08-28T10:02:00.000Z', payload: { type: 'agent_message' } },
      ]),
      'utf8',
    );

    const result = await importHistoryFile(transcript, { cwd: root, dataDir });
    expect(result).toMatchObject({ candidateTurns: 1, importedRuns: 1 });
    const store = new CalibrationStore({ dataDir });
    expect((await store.history())[0]?.outcome).toBe('censored');
    expect(await store.calibrationSamples()).toHaveLength(0);
  });

  it('rejects oversized JSONL rows without retaining them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-bounded-import-'));
    const transcript = join(root, 'bounded.jsonl');
    await writeFile(
      transcript,
      `${JSON.stringify({ oversized: 'x'.repeat(2 * 1024 * 1024) })}\n${jsonl([
        { type: 'user_message', timestamp: '2026-08-28T10:00:00.000Z', message: 'Review this.' },
        { type: 'turn.completed', timestamp: '2026-08-28T10:01:00.000Z' },
      ])}`,
      'utf8',
    );
    const result = await importHistoryFile(transcript, { cwd: root, dataDir: join(root, 'data') });
    expect(result).toMatchObject({ invalidLines: 1, importedRuns: 1 });
  });
});
