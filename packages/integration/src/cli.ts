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
  output(`${status.state} · ${status.eligibleCalibrationRuns} eligible runs`, false);
  if (status.medianAbsoluteErrorMinutes !== null) {
    output(`Median error ${status.medianAbsoluteErrorMinutes}m · planning coverage ${Math.round((status.p80ObservedCoverage ?? 0) * 100)}%`, false);
  }
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
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isDirectExecution()) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
