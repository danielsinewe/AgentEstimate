import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('plugins/agent-eta');

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

async function exists(path) {
  await access(resolve(root, path));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const codex = await json('.codex-plugin/plugin.json');
const claude = await json('.claude-plugin/plugin.json');
const hooks = await json('hooks/hooks.json');
const mcp = await json('.mcp.json');
const packageJson = await json('package.json');

for (const manifest of [codex, claude]) {
  assert(manifest.name === 'agent-eta', 'Plugin name must be agent-eta');
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version), 'Plugin version must be semver');
  assert(typeof manifest.description === 'string' && manifest.description.length > 20, 'Plugin description is missing');
  assert(manifest.license === 'MIT', 'Plugin license must be MIT');
}

assert(codex.skills === './skills/', 'Codex skills path is missing');
assert(codex.mcpServers === './.mcp.json', 'Codex MCP path is missing');
assert(codex.interface?.displayName === 'Agent ETA', 'Codex display name is missing');
for (const asset of [codex.interface?.composerIcon, codex.interface?.logo, codex.interface?.logoDark]) {
  assert(typeof asset === 'string', 'A required plugin asset is missing');
  await exists(asset);
}

const supportedHooks = ['UserPromptSubmit', 'Stop', 'SessionEnd'];
assert(Object.keys(hooks.hooks ?? {}).every((name) => supportedHooks.includes(name)), 'Unsupported hook event');
for (const name of supportedHooks) {
  const command = hooks.hooks?.[name]?.[0]?.hooks?.[0]?.command;
  assert(typeof command === 'string' && command.includes("dist','hook.mjs"), `${name} hook launcher is missing`);
  assert(command.includes('CODEX_PLUGIN_ROOT') && command.includes('CLAUDE_PLUGIN_ROOT'), `${name} hook is not portable`);
}

const server = mcp.mcpServers?.['agent-eta'];
assert(server?.command === 'node', 'MCP server must use Node');
assert(server.cwd === '.', 'MCP server must start in the plugin root');
assert(Array.isArray(server.args) && server.args.length === 1 && server.args[0] === './dist/mcp.mjs', 'MCP launcher is missing');
assert(packageJson.name === 'agent-eta-plugin', 'Plugin package name is invalid');

const skill = await readFile(resolve(root, 'skills/estimate/SKILL.md'), 'utf8');
assert(/^---\n[\s\S]*?\n---\n/u.test(skill), 'Skill frontmatter is invalid');
assert(/^name:\s*estimate$/mu.test(skill), 'Skill name is invalid');
assert(/^description:\s*\S.+$/mu.test(skill), 'Skill description is missing');

for (const runtime of ['dist/cli.mjs', 'dist/hook.mjs', 'dist/mcp.mjs']) await exists(runtime);

process.stdout.write(`Plugin validation passed: ${root}\n`);
