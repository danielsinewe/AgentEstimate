import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(
  process.env.AGENT_ETA_PLUGIN_ROOT ?? join(repositoryRoot, 'plugins', 'agent-eta'),
);
const dataDir = await mkdtemp(join(tmpdir(), 'agent-eta-smoke-'));
const hooks = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));

function commandFor(eventName) {
  const command = hooks.hooks?.[eventName]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== 'string') throw new Error(`Missing ${eventName} hook command`);
  return command;
}

function runCommand(command, input) {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const child = spawn(command, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CODEX_PLUGIN_ROOT: pluginRoot,
        AGENT_ETA_DATA_DIR: dataDir,
      },
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Plugin smoke command exceeded seven seconds'));
    }, 7_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`Plugin hook exited ${code}: ${stderr}`));
      resolvePromise({ stdout, elapsedMs: Math.round((performance.now() - started) * 10) / 10 });
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

const privatePromptMarker = 'SMOKE-PRIVATE-PROMPT-9182';
const sessionId = 'smoke-visible-session';
const turnId = 'smoke-turn';
const submitted = await runCommand(commandFor('UserPromptSubmit'), {
  hook_event_name: 'UserPromptSubmit',
  session_id: sessionId,
  turn_id: turnId,
  cwd: repositoryRoot,
  model: 'gpt-5.6-sol',
  prompt: `Review ${privatePromptMarker}, run tests, and verify the interface in a browser.`,
});
const submitOutput = JSON.parse(submitted.stdout);
if (typeof submitOutput.systemMessage !== 'string' || !submitOutput.systemMessage.includes('P80')) {
  throw new Error('Prompt-submit hook did not return an ETA');
}

const completed = await runCommand(commandFor('Stop'), {
  hook_event_name: 'Stop',
  session_id: sessionId,
  turn_id: turnId,
});
if (JSON.stringify(JSON.parse(completed.stdout)) !== '{}') throw new Error('Stop hook returned unexpected output');

const history = await readFile(join(dataDir, 'runs.jsonl'), 'utf8');
if (history.includes(privatePromptMarker) || history.includes(sessionId) || history.includes(repositoryRoot)) {
  throw new Error('Plugin smoke history retained private input');
}
const records = history.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
if (records.length !== 2 || records[0]?.kind !== 'started' || records[1]?.kind !== 'completed') {
  throw new Error('Plugin smoke lifecycle did not persist one complete run');
}

process.stdout.write(`${JSON.stringify({
  submitHookMs: submitted.elapsedMs,
  completionHookMs: completed.elapsedMs,
  systemMessage: submitOutput.systemMessage,
  persistedRecords: records.length,
  rawInputPersisted: false,
}, null, 2)}\n`);
