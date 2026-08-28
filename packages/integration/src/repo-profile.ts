import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryProfile } from './types.js';

const execFileAsync = promisify(execFile);

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '.yarn',
  '__pycache__',
  'bower_components',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'node_modules',
  'out',
  'pods',
  'target',
  'vendor',
  'venv',
]);

const BINARY_EXTENSIONS = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.dmg', '.doc', '.docx', '.eot', '.exe', '.gif', '.gz', '.ico',
  '.jar', '.jpeg', '.jpg', '.lockb', '.mov', '.mp3', '.mp4', '.o', '.otf', '.pdf', '.png', '.pyc', '.so', '.tar',
  '.tiff', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip',
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.astro': 'astro', '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.css': 'css', '.dart': 'dart',
  '.ex': 'elixir', '.exs': 'elixir', '.go': 'go', '.h': 'c', '.hpp': 'cpp', '.html': 'html', '.java': 'java',
  '.js': 'javascript', '.jsx': 'javascript', '.kt': 'kotlin', '.kts': 'kotlin', '.lua': 'lua', '.md': 'markdown', '.mjs': 'javascript',
  '.php': 'php', '.pl': 'perl', '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.scala': 'scala', '.sh': 'shell',
  '.sql': 'sql', '.svelte': 'svelte', '.swift': 'swift', '.tsx': 'typescript', '.ts': 'typescript', '.vue': 'vue',
};

const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:\.|_)(?:test|spec)\.[^/]+$/iu;

export interface ProfileRepositoryOptions {
  maxFiles?: number;
  maxSampleFiles?: number;
  gitTimeoutMs?: number;
  maxFileBytes?: number;
  readConcurrency?: number;
  budgetMs?: number;
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//u, '');
}

export function isExcludedRepositoryPath(path: string): boolean {
  const normalized = normalizeRelativePath(path);
  const segments = normalized.toLowerCase().split('/');
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return true;
  return BINARY_EXTENSIONS.has(extname(normalized).toLowerCase());
}

async function gitRoot(cwd: string, timeout: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return resolve(stdout.trim());
  } catch {
    return null;
  }
}

async function gitFiles(root: string, timeout: number): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    });
    return stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map(normalizeRelativePath)
      .filter((path) => !isExcludedRepositoryPath(path));
  } catch {
    return null;
  }
}

async function filesystemFiles(
  root: string,
  maxFiles: number,
  deadline: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const directories = [root];

  while (directories.length > 0 && files.length < maxFiles && Date.now() < deadline) {
    const directory = directories.pop();
    if (!directory) break;

    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      continue;
    }

    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      const path = normalizeRelativePath(relative(root, absolute));
      if (isExcludedRepositoryPath(path)) continue;
      if (entry.isDirectory()) directories.push(absolute);
      else if (entry.isFile()) files.push(path);
      if (files.length >= maxFiles) break;
    }
  }

  return { files, truncated: directories.length > 0 || files.length >= maxFiles };
}

async function readBoundedFile(path: string, maxBytes: number): Promise<{ bytes: Buffer; fileSize: number } | null> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const file = await handle.stat();
      if (!file.isFile()) return null;
      const byteCount = Math.min(file.size, maxBytes);
      const bytes = Buffer.alloc(byteCount);
      const { bytesRead } = byteCount > 0 ? await handle.read(bytes, 0, byteCount, 0) : { bytesRead: 0 };
      return { bytes: bytes.subarray(0, bytesRead), fileSize: file.size };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function countLines(path: string, maxBytes: number): Promise<number | null> {
  const file = await readBoundedFile(path, maxBytes);
  if (!file) return null;
  if (file.bytes.includes(0)) return 0;
  if (file.bytes.length === 0) return 0;
  let sampledLines = 1;
  for (const byte of file.bytes) if (byte === 10) sampledLines += 1;
  return Math.max(1, Math.round(sampledLines * (file.fileSize / file.bytes.length)));
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  deadline: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (Date.now() < deadline) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) return;
      results.push(await operation(value));
    }
  });
  await Promise.all(workers);
  return results;
}

async function sumDependencies(root: string, packageFiles: string[], deadline: number): Promise<number> {
  let count = 0;
  for (const path of packageFiles.slice(0, 100)) {
    if (Date.now() >= deadline) break;
    try {
      const file = await readBoundedFile(join(root, path), 1024 * 1024);
      if (!file || file.fileSize > file.bytes.length) continue;
      const parsed = JSON.parse(file.bytes.toString('utf8')) as Record<string, unknown>;
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const value = parsed[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) count += Object.keys(value).length;
      }
    } catch {
      // A malformed package file should not make prompt submission fail.
    }
  }
  return count;
}

async function dirtyFileCount(root: string, timeout: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1', '-uno'], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout.split(/\r?\n/u).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function deterministicSample<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return values;
  const result: T[] = [];
  const stride = values.length / limit;
  for (let index = 0; index < limit; index += 1) {
    const item = values[Math.floor(index * stride)];
    if (item !== undefined) result.push(item);
  }
  return result;
}

export async function profileRepository(
  cwd = process.cwd(),
  options: ProfileRepositoryOptions = {},
): Promise<RepositoryProfile> {
  const maxFiles = options.maxFiles ?? 50_000;
  const maxSampleFiles = options.maxSampleFiles ?? 500;
  const gitTimeoutMs = options.gitTimeoutMs ?? 1_200;
  const maxFileBytes = options.maxFileBytes ?? 128 * 1024;
  const readConcurrency = options.readConcurrency ?? 12;
  const deadline = Date.now() + (options.budgetMs ?? 5_000);
  const resolvedCwd = resolve(cwd);
  const remainingTimeout = () => Math.max(50, Math.min(gitTimeoutMs, deadline - Date.now()));
  const discoveredRoot = await gitRoot(resolvedCwd, remainingTimeout());
  const root = discoveredRoot ?? resolvedCwd;
  const trackedFiles = discoveredRoot && Date.now() < deadline ? await gitFiles(root, remainingTimeout()) : null;
  const fallback = trackedFiles ? null : await filesystemFiles(root, maxFiles, deadline);
  const allFiles = (trackedFiles ?? fallback?.files ?? []).slice(0, maxFiles);
  const truncated = Boolean(fallback?.truncated) || (trackedFiles?.length ?? 0) > maxFiles;
  const codeFiles = allFiles.filter((path) => LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] !== undefined);
  const sample = deterministicSample(codeFiles, maxSampleFiles);
  const lineCounts = await mapWithConcurrency(sample, readConcurrency, deadline, (path) =>
    countLines(join(root, path), maxFileBytes),
  );
  const validLineCounts = lineCounts.filter((value): value is number => value !== null);
  const sampledLines = validLineCounts.reduce((sum, lines) => sum + lines, 0);
  const linesOfCode = validLineCounts.length === 0
    ? 0
    : Math.round((sampledLines * codeFiles.length) / validLineCounts.length);
  const languages = new Set(codeFiles.map((path) => LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]).filter(Boolean));
  const packageFiles = allFiles.filter((path) => /(?:^|\/)package\.json$/u.test(path));

  return {
    root,
    source: trackedFiles ? 'git' : 'filesystem',
    fileCount: allFiles.length,
    linesOfCode,
    testFileCount: allFiles.filter((path) => TEST_FILE_PATTERN.test(path)).length,
    languageCount: languages.size,
    dependencyCount: await sumDependencies(root, packageFiles, deadline),
    packageCount: packageFiles.length,
    dirtyFileCount: trackedFiles && Date.now() < deadline ? await dirtyFileCount(root, remainingTimeout()) : 0,
    sampledCodeFiles: validLineCounts.length,
    truncated: truncated || validLineCounts.length < sample.length || Date.now() >= deadline,
  };
}
