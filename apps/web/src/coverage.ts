export function coverageAssessment(percentage: number): 'Too narrow' | 'On target' | 'Too wide' {
  if (percentage < 68) return 'Too narrow';
  if (percentage > 90) return 'Too wide';
  return 'On target';
}
