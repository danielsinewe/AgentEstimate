import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { createMcpServer } from '../src/mcp.js';
import { CalibrationStore } from '../src/store.js';
import { TEST_ESTIMATE, TEST_FEATURES } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('CLI', () => {
  it('prints help and reports invalid commands without throwing', async () => {
    const output = captureProcessOutput();
    expect(await runCli(['help'])).toBe(0);
    expect(output.stdout()).toContain('local time forecasts for coding agents');
    expect(await runCli(['does-not-exist'])).toBe(1);
    expect(output.stderr()).toContain('Unknown command: does-not-exist');
  });

  it('emits a machine-readable estimate without echoing the prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-cli-'));
    await writeFile(join(root, 'index.ts'), 'export const value = 1;', 'utf8');
    const dataDir = join(root, 'data');
    const secret = 'TOP-SECRET-CLI-TASK';
    const output = captureProcessOutput();
    const code = await runCli([
      'estimate',
      `Implement ${secret} with tests`,
      '--provider',
      'claude',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high',
      '--speed',
      'fast',
      '--cwd',
      root,
      '--data-dir',
      dataDir,
      '--json',
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(output.stdout()) as Record<string, unknown>;
    expect(result).toHaveProperty('minutes.p50');
    expect(result).toHaveProperty('formatted.p80');
    expect(result).toHaveProperty('repo.fileCount', 1);
    expect(output.stdout()).not.toContain(secret);
  });

  it('uses plain-language labels in human-readable estimates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-cli-copy-'));
    await writeFile(join(root, 'index.ts'), 'export const value = 1;', 'utf8');
    const output = captureProcessOutput();
    expect(await runCli(['estimate', 'Review this file.', '--cwd', root])).toBe(0);
    expect(output.stdout()).toMatch(/^Likely .+ · safer plan .+/u);
    expect(output.stdout()).not.toMatch(/P50|P80/u);
  });

  it('reports history and calibration from the private store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-cli-history-'));
    const store = new CalibrationStore({ dataDir });
    const startedAt = new Date('2026-08-28T10:00:00.000Z');
    await store.startRun({
      sessionId: 'session',
      repoIdentity: '/repo',
      startedAt,
      features: TEST_FEATURES,
      estimate: TEST_ESTIMATE,
    });
    await store.completeRun({
      sessionId: 'session',
      completedAt: new Date(startedAt.getTime() + 12 * 60_000),
      outcome: 'success',
    });

    const output = captureProcessOutput();
    expect(await runCli(['history', '--data-dir', dataDir, '--json'])).toBe(0);
    expect(JSON.parse(output.stdout())).toHaveLength(1);
    vi.restoreAllMocks();

    const calibrationOutput = captureProcessOutput();
    expect(await runCli(['calibrate', '--data-dir', dataDir, '--json'])).toBe(0);
    expect(JSON.parse(calibrationOutput.stdout())).toMatchObject({ successfulRuns: 1, state: 'cold-start' });
  });

  it('supports the history-import CLI alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-cli-import-'));
    const transcript = join(root, 'history.jsonl');
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: 'user_message', timestamp: '2026-08-28T10:00:00.000Z', message: 'Review this.' }),
        JSON.stringify({ type: 'turn.completed', timestamp: '2026-08-28T10:01:00.000Z' }),
      ].join('\n'),
      'utf8',
    );
    const output = captureProcessOutput();
    expect(
      await runCli(['history-import', transcript, '--cwd', root, '--data-dir', join(root, 'data'), '--json']),
    ).toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({ adapter: 'codex-jsonl', importedRuns: 1 });
  });
});

describe('MCP server', () => {
  it('exposes read-only tools and handles estimation and local run status end to end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-mcp-'));
    const dataDir = join(root, 'data');
    await writeFile(join(root, 'index.ts'), 'export const value = 1;', 'utf8');
    const server = createMcpServer({ dataDir, workspaceRoot: root });
    const client = new Client({ name: 'agent-eta-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(['calibration_status', 'current_run', 'estimate_task']);
      expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(listed.tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);

      const secret = 'MCP-PRIVATE-PROMPT-771';
      const estimate = await client.callTool({
        name: 'estimate_task',
        arguments: {
          prompt: `Implement ${secret}, add tests, and deploy.`,
          provider: 'codex',
          model: 'gpt-5.6-codex',
          effort: 'high',
          speed: 'fast',
          workspaceRoot: root,
        },
      });
      const estimateData = estimate.structuredContent as Record<string, unknown>;
      expect(estimateData).toMatchObject({
        taskClass: 'feature',
        repo: { fileCount: 1, languageCount: 1 },
        privacy: 'Prompt processed in memory; no prompt or source content was persisted.',
      });
      expect(estimateData).toHaveProperty('minutes.p50');
      expect(JSON.stringify(estimate)).not.toContain(secret);
      await expect(readFile(join(dataDir, 'runs.jsonl'), 'utf8')).rejects.toThrow();

      const noRun = await client.callTool({ name: 'current_run', arguments: { workspaceRoot: root } });
      expect(noRun.structuredContent).toEqual({ active: false });

      await new CalibrationStore({ dataDir }).startRun({
        sessionId: 'session',
        repoIdentity: root,
        startedAt: new Date(),
        features: TEST_FEATURES,
        estimate: TEST_ESTIMATE,
      });
      const activeRun = await client.callTool({ name: 'current_run', arguments: { workspaceRoot: root } });
      expect(activeRun.structuredContent).toMatchObject({
        active: true,
        provider: 'codex',
        model: 'gpt-5.6-codex',
        taskClass: 'feature',
        p50: '10 min',
        p80: '15 min',
      });
      const latestActiveRun = await client.callTool({ name: 'current_run', arguments: {} });
      expect(latestActiveRun.structuredContent).toMatchObject({ active: true, p50: '10 min', p80: '15 min' });
      const calibration = await client.callTool({ name: 'calibration_status', arguments: {} });
      expect(calibration.structuredContent).toMatchObject({ startedRuns: 1, completedRuns: 0 });

      const invalid = await client.callTool({ name: 'estimate_task', arguments: { prompt: '' } });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
