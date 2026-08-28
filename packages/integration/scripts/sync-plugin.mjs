import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDist = resolve(packageRoot, '../../plugins/agent-eta/dist');

await mkdir(pluginDist, { recursive: true });

for (const filename of ['cli.mjs', 'hook.mjs', 'mcp.mjs']) {
  const destination = resolve(pluginDist, filename);
  await copyFile(resolve(packageRoot, 'dist', filename), destination);
  await chmod(destination, 0o755);
}
