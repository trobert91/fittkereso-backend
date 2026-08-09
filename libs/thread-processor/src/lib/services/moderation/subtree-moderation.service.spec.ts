/**
 * Tests for the moderationPriority normalization formula. The full
 * SubtreeModerationService is wired through TypeORM repositories and dynamic
 * config, which is overkill to instantiate here — we test the formula
 * directly so the bounds and saturating curve stay correct under refactors.
 *
 * The formula must match the implementation in `subtree-moderation.service.ts`.
 */

const RELEVANCE_FLOOR = 0.1;

function moderationPriority(
  openIssueSeverity: number,
  relevance: number,
  severityCap = 200,
): number {
  const severityNorm = Math.min(openIssueSeverity, severityCap) / severityCap;
  const relevanceNorm = Math.max(relevance, RELEVANCE_FLOOR) / 100;
  const raw = 100 * severityNorm * relevanceNorm;
  return Math.max(1, Math.min(100, Math.round(raw)));
}

describe('moderationPriority normalization', () => {
  it('clean ref (severity=0, relevance=100) → 1 (floor)', () => {
    expect(moderationPriority(0, 100)).toBe(1);
  });

  it('saturated severity (200) and full relevance (100) → 100', () => {
    expect(moderationPriority(200, 100)).toBe(100);
  });

  it('worked example: severity=130, relevance=80 → ~52', () => {
    const value = moderationPriority(130, 80);
    expect(value).toBeGreaterThanOrEqual(50);
    expect(value).toBeLessThanOrEqual(54);
  });

  it('severity above cap clamps to 100', () => {
    expect(moderationPriority(500, 100)).toBe(100);
  });

  it('relevance=0 still uses the floor → priority is small but at least 1', () => {
    const value = moderationPriority(200, 0);
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(2);
  });

  it('respects an alternate severityCap', () => {
    // Halving the cap doubles the per-severity weight at the same severity.
    const lowCap = moderationPriority(100, 100, 100); // 100 / 100 * 1 * 100 = 100
    const highCap = moderationPriority(100, 100, 200); // 100 / 200 * 1 * 100 = 50
    expect(lowCap).toBe(100);
    expect(highCap).toBe(50);
  });
});
