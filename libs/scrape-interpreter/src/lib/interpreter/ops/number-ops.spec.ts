import { round } from './number-ops';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';

const ctx = {} as ScrapeExecutionContext;

describe('round', () => {
  // ebikeshop's prices carry float noise on both sides of the whole number.
  it.each([
    [3879000.0017, 3879000],
    [3898999.9998, 3899000],
    [1999000.0025, 1999000],
    [1799000, 1799000],
  ])('rounds %d to %d', (input, expected) => {
    expect(round(ctx, input, { op: 'round' })).toBe(expected);
  });

  it('keeps the requested decimal places', () => {
    expect(round(ctx, 379.9749, { op: 'round', decimals: 2 })).toBe(379.97);
  });

  it('reads a numeric string as a number', () => {
    expect(round(ctx, '3879000.0017', { op: 'round' })).toBe(3879000);
  });

  // A missing price must stay missing, not become 0.
  it.each([[undefined], [null], [''], ['n/a'], [false], [Number.NaN]])(
    'resolves %p to undefined',
    (input) => {
      expect(round(ctx, input, { op: 'round' })).toBeUndefined();
    },
  );
});
