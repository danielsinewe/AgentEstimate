import { describe, expect, it } from 'vitest';
import { coverageAssessment } from './coverage';

describe('coverageAssessment', () => {
  it('treats excessive coverage as an over-wide range instead of success', () => {
    expect(coverageAssessment(50)).toBe('Too narrow');
    expect(coverageAssessment(80)).toBe('On target');
    expect(coverageAssessment(95)).toBe('Too wide');
  });
});
