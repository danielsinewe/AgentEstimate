import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isExcludedRepositoryPath, profileRepository } from '../src/repo-profile.js';

const execFileAsync = promisify(execFile);

describe('repository path filtering', () => {
  it.each([
    'node_modules/pkg/index.ts',
    'src/vendor/library.js',
    'DIST/client.js',
    '.git/objects/pack.bin',
    'assets/photo.PNG',
    'docs/specification.pdf',
    'nested/.venv/lib/site.py',
  ])('excludes generated, vendored, VCS, and binary paths: %s', (path) => {
    expect(isExcludedRepositoryPath(path)).toBe(true);
  });

  it.each(['src/index.ts', 'packages/web/package.json', 'test/feature.test.ts', 'docs/architecture.md'])(
    'retains source and metadata paths: %s',
    (path) => {
      expect(isExcludedRepositoryPath(path)).toBe(false);
    },
  );
});

describe('profileRepository', () => {
  it('profiles a non-git repository while excluding dependencies, binaries, and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-profile-'));
    await Promise.all([
      mkdir(join(root, 'src'), { recursive: true }),
      mkdir(join(root, 'test'), { recursive: true }),
      mkdir(join(root, 'node_modules', 'private-package'), { recursive: true }),
      mkdir(join(root, 'dist'), { recursive: true }),
      mkdir(join(root, 'assets'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'src', 'index.ts'), 'const first = 1;\nconst second = 2;', 'utf8'),
      writeFile(join(root, 'test', 'index.test.ts'), 'expect(true).toBe(true);', 'utf8'),
      writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: { alpha: '1', beta: '1' },
          devDependencies: { vitest: '1' },
          peerDependencies: { react: '19' },
        }),
        'utf8',
      ),
      writeFile(join(root, 'node_modules', 'private-package', 'secret.ts'), 'doNotCount();', 'utf8'),
      writeFile(join(root, 'dist', 'bundle.js'), 'doNotCount();', 'utf8'),
      writeFile(join(root, 'assets', 'photo.png'), Buffer.from([0, 1, 2, 3])),
    ]);
    await symlink(join(root, 'src', 'index.ts'), join(root, 'linked-secret.ts'));

    const profile = await profileRepository(root, { maxSampleFiles: 100 });
    expect(profile).toMatchObject({
      root,
      source: 'filesystem',
      fileCount: 3,
      linesOfCode: 3,
      testFileCount: 1,
      languageCount: 1,
      dependencyCount: 4,
      packageCount: 1,
      dirtyFileCount: 0,
      sampledCodeFiles: 2,
      truncated: false,
    });
  });

  it('uses git-visible files, respects ignore rules, and reports dirty tracked files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-git-profile-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await Promise.all([
      mkdir(join(root, 'src'), { recursive: true }),
      mkdir(join(root, 'ignored'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8'),
      writeFile(join(root, 'src', 'tracked.ts'), 'export const tracked = true;', 'utf8'),
      writeFile(join(root, 'ignored', 'secret.ts'), 'neverCount();', 'utf8'),
    ]);
    await execFileAsync('git', ['add', '.gitignore', 'src/tracked.ts'], { cwd: root });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent ETA', '-c', 'user.email=agent-eta@example.invalid', 'commit', '-q', '-m', 'fixture'],
      { cwd: root },
    );
    await writeFile(join(root, 'src', 'tracked.ts'), 'export const tracked = false;', 'utf8');
    await writeFile(join(root, 'src', 'untracked.py'), 'print("visible")', 'utf8');

    const profile = await profileRepository(join(root, 'src'));
    expect(profile.root).toBe(await realpath(root));
    expect(profile.source).toBe('git');
    expect(profile.fileCount).toBe(3);
    expect(profile.languageCount).toBe(2);
    expect(profile.dirtyFileCount).toBe(1);
    expect(profile.testFileCount).toBe(0);
  });

  it('caps filesystem traversal and marks limited profiles as truncated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eta-capped-profile-'));
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => writeFile(join(root, `file-${index}.ts`), `export const n = ${index};`, 'utf8')),
    );
    const profile = await profileRepository(root, { maxFiles: 4, maxSampleFiles: 2 });
    expect(profile.fileCount).toBe(4);
    expect(profile.sampledCodeFiles).toBe(2);
    expect(profile.truncated).toBe(true);
  });
});
