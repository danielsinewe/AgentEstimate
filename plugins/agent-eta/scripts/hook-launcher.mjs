const MAX_HOOK_INPUT_BYTES = 2 * 1024 * 1024;
const ETA_UNAVAILABLE_MESSAGE = 'Agent ETA unavailable · prompt will continue';
const ETA_STRICT_MESSAGE = 'Agent ETA unavailable · prompt blocked by strict mode';
const ETA_STRICT_REASON = 'Agent ETA strict mode requires a forecast before this prompt can run. Set AGENT_ETA_STRICT=0 to continue without one.';

function strictModeEnabled() {
  return /^(?:1|true|yes|on)$/iu.test(process.env.AGENT_ETA_STRICT?.trim() ?? '');
}

function unavailableSubmitOutput() {
  if (strictModeEnabled()) {
    return {
      decision: 'block',
      reason: ETA_STRICT_REASON,
      systemMessage: ETA_STRICT_MESSAGE,
    };
  }

  return {
    systemMessage: ETA_UNAVAILABLE_MESSAGE,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        '<agent-eta-status>',
        ETA_UNAVAILABLE_MESSAGE,
        'Before any other commentary, answer, or tool call, show the status line above verbatim as the first user-visible response for this turn. Then continue with the request. Do not omit or paraphrase it.',
        '</agent-eta-status>',
      ].join('\n'),
    },
  };
}

function eventNameFrom(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    return typeof input?.hook_event_name === 'string' ? input.hook_event_name : undefined;
  } catch {
    return /"hook_event_name"\s*:\s*"UserPromptSubmit"/u.test(rawInput)
      ? 'UserPromptSubmit'
      : undefined;
  }
}

async function readHookInput() {
  const chunks = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= MAX_HOOK_INPUT_BYTES) chunks.push(buffer);
    else oversized = true;
  }
  return { rawInput: Buffer.concat(chunks).toString('utf8'), oversized };
}

export async function runHookLauncherProcess() {
  const { rawInput, oversized } = await readHookInput();
  const eventName = eventNameFrom(rawInput);
  try {
    if (oversized) throw new Error('Hook input exceeded the local processing limit');
    const hook = await import('../dist/hook.mjs');
    const output = await hook.handleHookInvocation(rawInput);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    const output = eventName === 'UserPromptSubmit' ? unavailableSubmitOutput() : {};
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}
