import { effectiveCooldownHours } from './backfill-cooldown';

describe('effectiveCooldownHours', () => {
  const cooldown = { baseCooldownHours: 168, backoffBase: 2, maxCooldownHours: 2160 };

  it('grows with attempt count', () => {
    expect(effectiveCooldownHours(0, cooldown)).toBe(168);
    expect(effectiveCooldownHours(1, cooldown)).toBe(336);
    expect(effectiveCooldownHours(2, cooldown)).toBe(672);
  });

  it('caps at maxCooldownHours', () => {
    expect(effectiveCooldownHours(20, cooldown)).toBe(2160);
  });
});
