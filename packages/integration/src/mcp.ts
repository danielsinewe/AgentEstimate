import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { estimateTask, formatDuration } from '@agent-eta/core';
import { z } from 'zod';
import {
  derivePromptFeatures,
  normalizeEffort,
  normalizeModel,
  normalizeSpeed,
} from './privacy.js';
import { profileRepository } from './repo-profile.js';
import { CalibrationStore } from './store.js';
import type { AgentProvider } from './types.js';

const VERSION = '0.1.0';
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const MAX_WORKSPACE_ROOT_LENGTH = 4_096;

export interface McpServerOptions {
  dataDir?: string;
  workspaceRoot?: string;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function providerValue(value: 'codex' | 'claude' | undefined): AgentProvider {
  return value ?? 'codex';
}

function isPluginRuntimeRoot(path: string): boolean {
  return /[/\\]plugins[/\\]cache[/\\][^/\\]+[/\\]agent-eta[/\\][^/\\]+$/u.test(path);
}

function resolveWorkspaceRoot(explicit: string | undefined, fallback: string | undefined): string | undefined {
  if (explicit) return resolve(explicit);
  if (!fallback || isPluginRuntimeRoot(fallback)) return undefined;
  return fallback;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const fallbackWorkspaceRoot = resolveWorkspaceRoot(options.workspaceRoot, resolve(process.cwd()));
  const server = new McpServer(
    { name: 'agent-eta', version: VERSION },
    { instructions: 'Estimate task duration locally. No prompt, source code, or tool output is persisted by MCP tools.' },
  );

  server.registerTool(
    'estimate_task',
    {
      title: 'Estimate task duration',
      description: 'Return a local expected duration and an allow-up-to planning time for a Codex or Claude Code task. The prompt is processed in memory and not stored.',
      inputSchema: {
        prompt: z.string().min(1).max(100_000).describe('The task to estimate. Processed locally and never persisted.'),
        provider: z.enum(['codex', 'claude']).optional(),
        model: z.string().max(80).optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        speed: z.enum(['standard', 'fast']).optional(),
        workspaceRoot: z.string().min(1).max(MAX_WORKSPACE_ROOT_LENGTH).optional()
          .describe('Absolute path of the active task repository. Omit only when the client has no workspace.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      prompt,
      provider: providerInput,
      model: modelInput,
      effort: effortInput,
      speed: speedInput,
      workspaceRoot: workspaceRootInput,
    }) => {
      const provider = providerValue(providerInput);
      const model = normalizeModel(modelInput, provider);
      const effort = normalizeEffort(effortInput);
      const speed = normalizeSpeed(speedInput);
      const promptFeatures = derivePromptFeatures(prompt);
      const activeWorkspaceRoot = resolveWorkspaceRoot(workspaceRootInput, fallbackWorkspaceRoot);
      const repo = activeWorkspaceRoot
        ? await profileRepository(activeWorkspaceRoot).catch(() => null)
        : null;
      const store = new CalibrationStore({ dataDir: options.dataDir });
      const calibrationSamples = await store.calibrationSamples().catch(() => []);
      const estimate = estimateTask({
        prompt,
        provider,
        model,
        effort,
        speed,
        repo: repo
          ? {
              fileCount: repo.fileCount,
              linesOfCode: repo.linesOfCode,
              testFileCount: repo.testFileCount,
              languageCount: repo.languageCount,
              dependencyCount: repo.dependencyCount,
              packageCount: repo.packageCount,
            }
          : undefined,
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
        calibrationSamples,
      });

      return jsonResult({
        summary: `About ${estimate.formatted.p50} · allow up to ${estimate.formatted.p80}`,
        p50: estimate.formatted.p50,
        p80: estimate.formatted.p80,
        minutes: estimate.minutes,
        confidence: estimate.confidence,
        taskClass: estimate.analysis.taskClass,
        stages: estimate.stages,
        drivers: estimate.drivers.slice(0, 3),
        calibration: estimate.calibration,
        repo: repo
          ? {
              fileCount: repo.fileCount,
              linesOfCode: repo.linesOfCode,
              languageCount: repo.languageCount,
              packageCount: repo.packageCount,
            }
          : null,
        privacy: 'Prompt processed in memory; no prompt or source content was persisted.',
      });
    },
  );

  server.registerTool(
    'current_run',
    {
      title: 'Current Agent ETA run',
      description: 'Read the latest non-stale hook-tracked forecast. Optionally scope it to the active task repository.',
      inputSchema: {
        workspaceRoot: z.string().min(1).max(MAX_WORKSPACE_ROOT_LENGTH).optional()
          .describe('Absolute path of the active task repository. Omit to read the latest active run.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceRoot: workspaceRootInput }) => {
      const store = new CalibrationStore({ dataDir: options.dataDir });
      const activeWorkspaceRoot = resolveWorkspaceRoot(workspaceRootInput, fallbackWorkspaceRoot);
      const current = await store.currentRun(activeWorkspaceRoot ? { repoIdentity: activeWorkspaceRoot } : {});
      if (!current) return jsonResult({ active: false });
      const elapsedMinutes = Math.max(0, (Date.now() - Date.parse(current.startedAt)) / 60_000);
      const status = elapsedMinutes <= current.estimate.minutes.p50
        ? `Working ${formatDuration(elapsedMinutes)} · within estimate`
        : elapsedMinutes <= current.estimate.minutes.p80
          ? `Working ${formatDuration(elapsedMinutes)} · still within plan`
          : `Working ${formatDuration(elapsedMinutes)} · taking longer than planned`;
      return jsonResult({
        active: true,
        runId: current.runId,
        startedAt: current.startedAt,
        elapsedMinutes,
        status,
        provider: current.features.provider,
        model: current.features.model,
        taskClass: current.features.prompt.taskClass,
        p50: current.estimate.formatted.p50,
        p80: current.estimate.formatted.p80,
      });
    },
  );

  server.registerTool(
    'calibration_status',
    {
      title: 'Agent ETA calibration status',
      description: 'Read local sample count and interval coverage. No history is modified.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const store = new CalibrationStore({ dataDir: options.dataDir });
      return jsonResult(await store.calibrationStatus());
    },
  );

  return server;
}

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(
    entry &&
    import.meta.url === pathToFileURL(entry).href &&
    /\/mcp\.(?:mjs|js|ts)$/u.test(new URL(import.meta.url).pathname),
  );
}

if (isDirectExecution()) {
  runMcpServer().catch((error: unknown) => {
    process.stderr.write(`Agent ETA MCP failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
