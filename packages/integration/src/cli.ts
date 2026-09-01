import { pathToFileURL } from 'node:url';
import { estimateTask } from '@agent-eta/core';
import { runHookProcess } from './hook.js';
import { importHistoryFile } from './history-import.js';
import { runMcpServer } from './mcp.js';
import {
  derivePromptFeatures,
  normalizeEffort,
  normalizeModel,
  normalizeSpeed,
} from './privacy.js';
import { profileRepository } from './repo-profile.js';
import { CalibrationStore } from './store.js';
import type { AgentProvider, RunHistoryEntry } from './types.js';

const HELP = `Agent ETA — local time forecasts for coding agents

Usage:
  agent-eta estimate [prompt] [--provider codex|claude] [--model MODEL]
  agent-eta hook [--provider codex|claude]
  agent-eta calibrate [--json]
  agent-eta backtest [--json]
  agent-eta history [--limit 20] [--json]
  agent-eta history-import FILE [--provider auto|codex|claude] [--json]
  agent-eta mcp

When estimate has no prompt argument, Agent ETA reads the prompt from stdin.
History imports are experimental. Raw prompts and code are never persisted.`;

interface ParsedCommandArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

class CliError extends Error {}

function parseCommandArgs(args: string[]): ParsedCommandArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  const booleanOptions = new Set(['json', 'help']);
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (positionalOnly || !argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
      continue;
    }
    const equalIndex = argument.indexOf('=');
    const key = argument.slice(2, equalIndex >= 0 ? equalIndex : undefined);
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    const value = equalIndex >= 0 ? argument.slice(equalIndex + 1) : args[index + 1];
    if (!value || (equalIndex < 0 && value.startsWith('--'))) throw new CliError(`Missing value for --${key}`);
    options[key] = value;
    if (equalIndex < 0) index += 1;
  }
  return { positionals, options };
}

function optionString(args: ParsedCommandArgs, key: string): string | undefined {
  const value = args.options[key];
  return typeof value === 'string' ? value : undefined;
}

function providerOption(value: string | undefined, allowAuto = false): AgentProvider | 'auto' {
  if (!value) return allowAuto ? 'auto' : 'codex';
  if (value === 'codex' || value === 'claude' || (allowAuto && value === 'auto')) return value;
  throw new CliError(`Unsupported provider: ${value}`);
}

async function readPromptFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > 2 * 1024 * 1024) throw new CliError('Prompt is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function output(value: unknown, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${String(value)}\n`);
}

async function estimateCommand(args: ParsedCommandArgs): Promise<void> {
  const prompt = args.positionals.join(' ').trim() || (await readPromptFromStdin());
  if (!prompt) throw new CliError('Provide a task to estimate, or pipe one through stdin.');
  const provider = providerOption(optionString(args, 'provider')) as AgentProvider;
  const model = normalizeModel(optionString(args, 'model'), provider);
  const effort = normalizeEffort(optionString(args, 'effort'));
  const speed = normalizeSpeed(optionString(args, 'speed'));
  const cwd = optionString(args, 'cwd') ?? process.cwd();
  const repo = await profileRepository(cwd);
  const promptFeatures = derivePromptFeatures(prompt);
  const store = new CalibrationStore({ dataDir: optionString(args, 'data-dir') });
  const calibrationSamples = await store.calibrationSamples().catch(() => []);
  const estimate = estimateTask({
    prompt,
    provider,
    model,
    effort,
    speed,
    repo: {
      fileCount: repo.fileCount,
      linesOfCode: repo.linesOfCode,
      testFileCount: repo.testFileCount,
      languageCount: repo.languageCount,
      dependencyCount: repo.dependencyCount,
      packageCount: repo.packageCount,
    },
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

  if (args.options.json) {
    output(
      {
        ...estimate,
        repo: {
          fileCount: repo.fileCount,
          linesOfCode: repo.linesOfCode,
          languageCount: repo.languageCount,
          packageCount: repo.packageCount,
        },
      },
      true,
    );
    return;
  }
  output(`About ${estimate.formatted.p50} · allow up to ${estimate.formatted.p80}`, false);
  if (estimate.drivers.length > 0) {
    output(`Drivers: ${estimate.drivers.slice(0, 3).map((driver) => driver.label).join(' · ')}`, false);
  }
}

async function calibrateCommand(args: ParsedCommandArgs): Promise<void> {
  const store = new CalibrationStore({ dataDir: optionString(args, 'data-dir') });
  const status = await store.calibrationStatus();
  if (args.options.json) {
    output(status, true);
    return;
  }
  output(`${status.reliability} · ${status.eligibleCalibrationRuns} eligible runs`, false);
  if (status.medianAbsoluteErrorMinutes !== null) {
    output(
      `Midpoint coverage ${Math.round((status.p50ObservedCoverage ?? 0) * 100)}% (target 50%) · planning coverage ${Math.round((status.p80ObservedCoverage ?? 0) * 100)}% (target 80%)`,
      false,
    );
    output(
      `Median error ${status.medianAbsoluteErrorMinutes}m · signed bias ${status.medianSignedErrorMinutes ?? 0}m`,
      false,
    );
  }
}

interface BacktestRow {
  actual: number;
  originalP50: number;
  originalP80: number;
  candidateP50: number;
  candidateP80: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function rounded(value: number | null, digits = 3): number | null {
  if (value === null) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function backtestMetrics(rows: readonly BacktestRow[], version: 'original' | 'candidate') {
  const p50Key = version === 'original' ? 'originalP50' : 'candidateP50';
  const p80Key = version === 'original' ? 'originalP80' : 'candidateP80';
  if (rows.length === 0) {
    return { medianAbsoluteErrorMinutes: null, midpointCoverage: null, planningCoverage: null };
  }
  return {
    medianAbsoluteErrorMinutes: rounded(median(rows.map((row) => Math.abs(row[p50Key] - row.actual))), 2),
    midpointCoverage: rounded(rows.filter((row) => row.actual <= row[p50Key]).length / rows.length),
    planningCoverage: rounded(rows.filter((row) => row.actual <= row[p80Key]).length / rows.length),
  };
}

async function backtestCommand(args: ParsedCommandArgs): Promise<void> {
  const store = new CalibrationStore({ dataDir: optionString(args, 'data-dir') });
  const history = (await store.history(Number.MAX_SAFE_INTEGER)).filter(
    (entry): entry is RunHistoryEntry & { elapsedMs: number; outcome: 'success' } =>
      entry.elapsedMs !== undefined && entry.outcome === 'success',
  );
  const samples = await store.calibrationSamples(Number.MAX_SAFE_INTEGER);
  const rows = history.map((entry, index): BacktestRow => {
    const features = entry.features;
    const candidate = estimateTask({
      prompt: '',
      provider: features.provider,
      model: features.model,
      effort: features.effort,
      speed: features.speed,
      taskClass: features.prompt.taskClass,
      options: {
        scope: features.prompt.scope,
        ambiguity: features.prompt.ambiguity,
        external: features.prompt.external,
        tests: features.prompt.tests,
        browser: features.prompt.browser,
        deploy: features.prompt.deploy,
        destructive: features.prompt.destructive,
      },
      repo: features.repo,
      calibrationSamples: samples.filter((_, sampleIndex) => sampleIndex !== index),
    });
    return {
      actual: entry.elapsedMs / 60_000,
      originalP50: entry.estimate.minutes.p50,
      originalP80: entry.estimate.minutes.p80,
      candidateP50: candidate.minutes.p50,
      candidateP80: candidate.minutes.p80,
    };
  });
  const result = {
    method: 'leave-one-out',
    successfulRuns: rows.length,
    targets: { midpointCoverage: 0.5, planningCoverage: 0.8 },
    original: backtestMetrics(rows, 'original'),
    candidate: backtestMetrics(rows, 'candidate'),
  };

  if (args.options.json) {
    output(result, true);
    return;
  }
  if (rows.length === 0) {
    output('No successful runs to backtest.', false);
    return;
  }
  output(`Leave-one-out backtest · ${rows.length} completed runs`, false);
  output(
    `Median error ${result.original.medianAbsoluteErrorMinutes}m → ${result.candidate.medianAbsoluteErrorMinutes}m`,
    false,
  );
  output(
    `Midpoint ${Math.round((result.candidate.midpointCoverage ?? 0) * 100)}% (target 50%) · planning ${Math.round((result.candidate.planningCoverage ?? 0) * 100)}% (target 80%)`,
    false,
  );
}

function historyLine(entry: RunHistoryEntry): string {
  const actual = entry.elapsedMs === undefined ? 'running' : `${Math.round(entry.elapsedMs / 60_000)}m ${entry.outcome ?? ''}`.trim();
  return `${entry.startedAt.slice(0, 16).replace('T', ' ')}  ${entry.features.provider.padEnd(6)}  ${entry.features.prompt.taskClass.padEnd(9)}  about ${entry.estimate.formatted.p50.padEnd(7)}  ${actual}`;
}

async function historyCommand(args: ParsedCommandArgs): Promise<void> {
  if (args.positionals[0] === 'import') {
    await historyImportCommand({ ...args, positionals: args.positionals.slice(1) });
    return;
  }
  const limitValue = Number.parseInt(optionString(args, 'limit') ?? '20', 10);
  const limit = Number.isFinite(limitValue) ? Math.min(1_000, Math.max(1, limitValue)) : 20;
  const store = new CalibrationStore({ dataDir: optionString(args, 'data-dir') });
  const history = await store.history(limit);
  if (args.options.json) {
    output(history, true);
    return;
  }
  if (history.length === 0) {
    output('No local runs yet.', false);
    return;
  }
  for (const entry of history) output(historyLine(entry), false);
}

async function historyImportCommand(args: ParsedCommandArgs): Promise<void> {
  const path = args.positionals[0];
  if (!path) throw new CliError('Provide a Codex or Claude JSONL history file.');
  const result = await importHistoryFile(path, {
    provider: providerOption(optionString(args, 'provider'), true),
    cwd: optionString(args, 'cwd'),
    dataDir: optionString(args, 'data-dir'),
  });
  if (args.options.json) {
    output(result, true);
    return;
  }
  output(`Experimental ${result.adapter}: imported ${result.importedRuns}, duplicates ${result.duplicateRuns}, skipped ${result.skippedRuns}.`, false);
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const [command = 'help', ...rest] = argv;
  try {
    const args = parseCommandArgs(rest);
    if (command === 'help' || command === '--help' || command === '-h' || args.options.help) {
      output(HELP, false);
      return 0;
    }
    if (command === 'estimate') await estimateCommand(args);
    else if (command === 'hook') {
      const provider = providerOption(optionString(args, 'provider')) as AgentProvider;
      await runHookProcess({ provider, dataDir: optionString(args, 'data-dir') });
    } else if (command === 'calibrate') await calibrateCommand(args);
    else if (command === 'backtest') await backtestCommand(args);
    else if (command === 'history') await historyCommand(args);
    else if (command === 'history-import') await historyImportCommand(args);
    else if (command === 'mcp') await runMcpServer({ dataDir: optionString(args, 'data-dir') });
    else throw new CliError(`Unknown command: ${command}`);
    return 0;
  } catch (error) {
    process.stderr.write(`Agent ETA: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    return 1;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(
    entry &&
    import.meta.url === pathToFileURL(entry).href &&
    /\/cli\.(?:mjs|js|ts)$/u.test(new URL(import.meta.url).pathname),
  );
}

if (isDirectExecution()) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
