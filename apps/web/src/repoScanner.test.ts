import { describe, expect, it } from 'vitest';
import { isIgnoredPath, languageForPath } from './repoScanner';

describe('repository scanner helpers', () => {
  it('excludes dependencies and generated output at any depth', () => {
    expect(isIgnoredPath('app/node_modules/react/index.js')).toBe(true);
    expect(isIgnoredPath('packages/site/dist/index.js')).toBe(true);
    expect(isIgnoredPath('src/components/Button.tsx')).toBe(false);
  });

  it('classifies common source files without guessing unknown formats', () => {
    expect(languageForPath('src/App.tsx')).toBe('TypeScript');
    expect(languageForPath('api/main.py')).toBe('Python');
    expect(languageForPath('assets/photo.webp')).toBeNull();
  });
});
