export interface ScannedRepository {
  name: string;
  files: number;
  lines: number;
  packages: number;
  testFiles: number;
  sourceBytes: number;
  languages: string[];
  monorepo: boolean;
  dirtyFiles: number;
  locSampled?: boolean;
}

const IGNORED_SEGMENTS = new Set([
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
  '.vercel',
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

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  astro: 'Astro',
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  cs: 'C#',
  css: 'CSS',
  dart: 'Dart',
  ex: 'Elixir',
  exs: 'Elixir',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  js: 'JavaScript',
  jsx: 'JavaScript',
  kt: 'Kotlin',
  kts: 'Kotlin',
  md: 'Markdown',
  mjs: 'JavaScript',
  php: 'PHP',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  scala: 'Scala',
  scss: 'SCSS',
  sh: 'Shell',
  sql: 'SQL',
  svelte: 'Svelte',
  swift: 'Swift',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  vue: 'Vue',
  zig: 'Zig',
};

const PACKAGE_FILES = new Set([
  'Cargo.toml',
  'Package.swift',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'go.mod',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
]);

const TEXT_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

export function isIgnoredPath(path: string): boolean {
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  return parts.some((part) => IGNORED_SEGMENTS.has(part) || part.startsWith('.cache'));
}

export function languageForPath(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension ? LANGUAGE_BY_EXTENSION[extension] ?? null : null;
}

function looksLikeTest(path: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path);
}

async function estimateLines(file: File): Promise<number> {
  if (file.size === 0) return 0;
  const sampleSize = Math.min(file.size, 128 * 1024);
  const text = await file.slice(0, sampleSize).text();
  const sampledLines = text.split('\n').length;
  return Math.max(1, Math.round(sampledLines * (file.size / sampleSize)));
}

function deterministicSample<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  const sample: T[] = [];
  const stride = values.length / limit;
  for (let index = 0; index < limit; index += 1) {
    const value = values[Math.floor(index * stride)];
    if (value !== undefined) sample.push(value);
  }
  return sample;
}

async function estimateSampledLines(files: readonly File[]): Promise<number[]> {
  const results: number[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (true) {
      const file = files[nextIndex];
      nextIndex += 1;
      if (!file) return;
      try {
        results.push(await estimateLines(file));
      } catch {
        results.push(0);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function scanRepository(fileList: FileList | File[]): Promise<ScannedRepository> {
  const input = Array.from(fileList);
  const included = input.filter((file) => !isIgnoredPath(file.webkitRelativePath || file.name));
  const rootName = included[0]?.webkitRelativePath.split('/')[0] || 'Selected folder';
  const languageBytes = new Map<string, number>();
  let sourceBytes = 0;
  let packages = 0;
  let testFiles = 0;
  const sourceFiles: File[] = [];

  for (const file of included) {
    const path = file.webkitRelativePath || file.name;
    const filename = path.split('/').pop() || file.name;
    const language = languageForPath(path);

    if (PACKAGE_FILES.has(filename)) packages += 1;
    if (looksLikeTest(path)) testFiles += 1;
    if (!language) continue;

    sourceBytes += file.size;
    sourceFiles.push(file);
    languageBytes.set(language, (languageBytes.get(language) || 0) + file.size);
  }

  const candidates = deterministicSample(
    sourceFiles.filter((file) => TEXT_EXTENSIONS.has(file.name.split('.').pop()?.toLowerCase() || '')),
    256,
  );
  const sample: File[] = [];
  let sampledReadBytes = 0;
  for (const file of candidates) {
    const readBytes = Math.min(file.size, 128 * 1024);
    if (sample.length > 0 && sampledReadBytes + readBytes > 16 * 1024 * 1024) continue;
    sample.push(file);
    sampledReadBytes += readBytes;
  }
  const sampledLineEstimates = await estimateSampledLines(sample);
  const sampledSourceBytes = sample.reduce((sum, file) => sum + file.size, 0);
  const sampledLines = sampledLineEstimates.reduce((sum, count) => sum + count, 0);
  const lines = sampledSourceBytes > 0
    ? Math.round(sampledLines * (sourceBytes / sampledSourceBytes))
    : 0;
  const locSampled = sample.length < sourceFiles.length || sample.some((file) => file.size > 128 * 1024);

  const languages = [...languageBytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([language]) => language);

  const workspaceMarkers = included.filter((file) =>
    /(^|\/)(pnpm-workspace\.yaml|lerna\.json|nx\.json|turbo\.json)$/.test(
      file.webkitRelativePath || file.name,
    ),
  );

  return {
    name: rootName,
    files: included.length,
    lines,
    packages,
    testFiles,
    sourceBytes,
    languages,
    monorepo: workspaceMarkers.length > 0 || packages > 3,
    dirtyFiles: 0,
    locSampled,
  };
}
