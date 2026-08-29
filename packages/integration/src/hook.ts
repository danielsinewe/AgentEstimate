import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { estimateTask } from '@agent-eta/core';
import {
  derivePromptFeatures,
  normalizeEffort,
  normalizeModel,
  normalizeProvider,
  normalizeSpeed,
  toStoredEstimate,
  toStoredFeatures,
} from './privacy.js';
import { profileRepository } from './repo-profile.js';
import { CalibrationStore } from './store.js';
import type { AgentProvider, HookInput, HookOutput, RepositoryProfile } from './types.js';

const MAX_HOOK_INPUT_BYTES = 2 * 1024 * 1024;

export interface HookInvocationOptions {
  provider?: AgentProvider;
  dataDir?: string;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hookEffort(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return asString((value as { level?: unknown }).level);
}

function emptyProfile(cwd: string): RepositoryProfile {
  return {
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
  };
}

async function safeProfile(cwd: string, store: CalibrationStore): Promise<RepositoryProfile> {
  const cached = await store.cachedRepositoryProfile(cwd).catch(() => null);
  if (cached) return cached;
  try {
    const profile = await profileRepository(cwd, {
      gitTimeoutMs: 350,
      maxFiles: 30_000,
      maxSampleFiles: 120,
      maxFileBytes: 64 * 1024,
      readConcurrency: 8,
      budgetMs: 1_100,
    });
    await store.cacheRepositoryProfile(cwd, profile).catch(() => undefined);
    return profile;
  } catch {
    return emptyProfile(cwd);
  }
}

function providerFor(
  input: HookInput,
  explicit?: AgentProvider,
  environment: NodeJS.ProcessEnv = process.env,
): AgentProvider {
  if (explicit) return explicit;
  const configured = asString(environment.AGENT_ETA_PROVIDER);
  if (configured) return normalizeProvider(configured, 'codex');
  if (environment.CODEX_PLUGIN_ROOT || environment.PLUGIN_ROOT) return 'codex';
  if (environment.CLAUDE_PLUGIN_ROOT) return 'claude';
  return normalizeProvider(input.model, 'codex');
}

function runtimeConfiguration(input: HookInput, options: HookInvocationOptions) {
  const environment = options.environment ?? process.env;
  const provider = providerFor(input, options.provider, environment);
  const modelSignal = asString(environment.AGENT_ETA_MODEL) ?? asString(input.model);
  const effortSignal = asString(environment.AGENT_ETA_EFFORT)
    ?? asString(input.reasoning_effort)
    ?? hookEffort(input.effort);
  const speedSignal = asString(environment.AGENT_ETA_SPEED)
    ?? asString(input.speed)
    ?? asString(input.service_tier);

  return {
    provider,
    model: normalizeModel(modelSignal, provider),
    effort: normalizeEffort(effortSignal),
    speed: normalizeSpeed(speedSignal),
    assumed: [
      ...(!modelSignal ? [`${provider}-default model`] : []),
      ...(!effortSignal ? ['medium effort'] : []),
      ...(!speedSignal ? ['standard speed'] : []),
    ],
  };
}

function buildCoreRepo(profile: RepositoryProfile) {
  return {
    fileCount: profile.fileCount,
    linesOfCode: profile.linesOfCode,
    testFileCount: profile.testFileCount,
    languageCount: profile.languageCount,
    dependencyCount: profile.dependencyCount,
    packageCount: profile.packageCount,
  };
}

async function handleSubmit(input: HookInput, options: HookInvocationOptions): Promise<HookOutput> {
  const prompt = asString(input.prompt);
  if (!prompt) return {};
  const { provider, model, effort, speed, assumed } = runtimeConfiguration(input, options);
  const cwd = asString(input.cwd) ?? process.cwd();
  const promptFeatures = derivePromptFeatures(prompt);
  const store = new CalibrationStore({ dataDir: options.dataDir });
  const repo = await safeProfile(cwd, store);
  const calibrationSamples = await store.calibrationSamples().catch(() => []);
  const estimate = estimateTask({
    prompt,
    provider,
    model,
    effort,
    speed,
    repo: buildCoreRepo(repo),
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

  const now = (options.now ?? (() => new Date()))();
  const sessionId = asString(input.session_id) ?? asString(input.sessionId) ?? 'anonymous-session';
  const turnId = asString(input.turn_id) ?? asString(input.turnId);
  const promptFingerprint = createHash('sha256').update(prompt).digest('hex').slice(0, 16);
  const identityHint = turnId
    ? `${provider}:${sessionId}:${turnId}`
    : `${provider}:${sessionId}:${now.toISOString()}:${promptFingerprint}`;

  try {
    await store.startRun({
      sessionId: `${provider}:${sessionId}`,
      turnId,
      repoIdentity: cwd,
      startedAt: now,
      features: toStoredFeatures({ provider, model, effort, speed, prompt: promptFeatures, repo }),
      estimate: toStoredEstimate(estimate),
      identityHint,
    });
  } catch {
    // Estimation remains useful even when the local calibration store is unavailable.
  }

  const assumptionNote = assumed.length
    ? ` · assumes ${assumed.join(' + ')} (AGENT_ETA_* can override)`
    : '';
  const forecastMessage = `Agent ETA · likely ${estimate.formatted.p50} · safer plan ${estimate.formatted.p80}${assumptionNote}`;
  return {
    systemMessage: forecastMessage,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        '<agent-eta-forecast>',
        forecastMessage,
        'Before any other commentary, answer, or tool call, show the forecast line above verbatim as the first user-visible response for this turn. Then continue with the request. Do not omit, paraphrase, or recalculate it.',
        '</agent-eta-forecast>',
      ].join('\n'),
    },
  };
}

async function handleCompletion(
  input: HookInput,
  options: HookInvocationOptions,
  outcome: 'success' | 'failed' | 'censored',
): Promise<HookOutput> {
  const provider = providerFor(input, options.provider, options.environment ?? process.env);
  const sessionId = asString(input.session_id) ?? asString(input.sessionId);
  if (!sessionId) return {};
  try {
    const store = new CalibrationStore({ dataDir: options.dataDir });
    const turnId = asString(input.turn_id) ?? asString(input.turnId);
    await store.completeRun({
      sessionId: `${provider}:${sessionId}`,
      ...(turnId ? { turnId } : {}),
      completedAt: (options.now ?? (() => new Date()))(),
      outcome,
      completeAll: outcome === 'censored',
    });
  } catch {
    // Lifecycle hooks are telemetry, never a gate for the coding agent.
  }
  return {};
}

export async function handleHookObject(input: HookInput, options: HookInvocationOptions = {}): Promise<HookOutput> {
  const eventName = asString(input.hook_event_name);
  if (eventName === 'UserPromptSubmit') return handleSubmit(input, options);
  if (eventName === 'Stop') return handleCompletion(input, options, 'success');
  if (eventName === 'StopFailure') return handleCompletion(input, options, 'failed');
  if (eventName === 'SessionEnd') return handleCompletion(input, options, 'censored');
  return {};
}

export async function handleHookInvocation(rawInput: string, options: HookInvocationOptions = {}): Promise<HookOutput> {
  try {
    if (Buffer.byteLength(rawInput, 'utf8') > MAX_HOOK_INPUT_BYTES) return {};
    const parsed: unknown = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return await handleHookObject(parsed as HookInput, options);
  } catch {
    return {};
  }
}

export async function readHookStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_HOOK_INPUT_BYTES) return '';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runHookProcess(options: HookInvocationOptions = {}): Promise<void> {
  const rawInput = await readHookStdin();
  const output = await handleHookInvocation(rawInput, options);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isDirectExecution()) {
  runHookProcess().catch(() => {
    process.stdout.write('{}\n');
  });
}
