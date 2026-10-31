import { describe, expect, it } from 'vitest';
import { clearLocalHistory, loadLocalHistory, LOCAL_HISTORY_STORAGE_KEY } from './localHistory';

describe('clearing local history', () => {
  it('removes local history while preserving unrelated app and sign-in storage', () => {
    const values = new Map([
      [LOCAL_HISTORY_STORAGE_KEY, '[{"id":"owner-qa"}]'],
      ['agent-eta-preferences', 'keep'],
      ['shared-auth-session', 'keep'],
    ]);
    clearLocalHistory({ removeItem: (key) => { values.delete(key); } });
    expect(loadLocalHistory({ getItem: (key) => values.get(key) ?? null })).toEqual([]);
    expect([...values]).toEqual([
      ['agent-eta-preferences', 'keep'],
      ['shared-auth-session', 'keep'],
    ]);
  });

  it('reports storage failure so the UI can retain history instead of claiming deletion', () => {
    expect(() => clearLocalHistory({ removeItem: () => { throw new Error('Storage blocked'); } }))
      .toThrow('Storage blocked');
  });
});
