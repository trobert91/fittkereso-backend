import {
  detailRefreshDueAt,
  detailRefreshIntervalMs,
  detailRefreshLead,
} from './detail-refresh-schedule';

const DAY = 24 * 60 * 60 * 1000;
const SIXTY_DAYS = 60 * DAY;

/**
 * 605 product URLs in ebikeshop's shape (its e-bike listing's size): a
 * name slug per brand, model, size and colour. Synthetic, since the fixtures
 * hold a dozen; what matters is that they differ the way real slugs do.
 */
function ebikeshopLikeUrls(count: number): string[] {
  const brands = ['ktm', 'rm', 'haibike', 'cube', 'corratec', 'winora'];
  const models = [
    'macina-style-820',
    'macina-gran-810',
    'macina-scarp-sx',
    'chacana-791',
    'delite4-gt-vario',
    'homage5-gt-rohloff',
    'allmtn-cf-11',
    'supreme-hybrid-pro-600',
    'nevo5-gt-touring',
    'tinker2-vario',
  ];
  const sizes = ['43', '46', '48', '51', '53', '56', '60'];
  const colours = ['fekete', 'feher', 'szurke', 'kek', 'zold'];
  const urls: string[] = [];
  for (const brand of brands) {
    for (const model of models) {
      for (const size of sizes) {
        for (const colour of colours) {
          urls.push(`https://ebikeshop.hu/termek/${brand}-${model}-${size}-cm-${colour}-elektromos-kerekpar`);
          if (urls.length === count) return urls;
        }
      }
    }
  }
  return urls;
}

describe('detailRefreshIntervalMs', () => {
  it("reads the source's interval", () => {
    expect(detailRefreshIntervalMs({ detailRefreshInterval: '8w' })).toBe(56 * DAY);
  });

  it('falls back to 60 days for an interval it cannot read', () => {
    expect(detailRefreshIntervalMs({ detailRefreshInterval: 'soha' as never })).toBe(SIXTY_DAYS);
    expect(detailRefreshIntervalMs({ detailRefreshInterval: undefined as never })).toBe(SIXTY_DAYS);
  });
});

describe('detailRefreshDueAt', () => {
  const lastUpdated = new Date('2026-09-26T03:00:00Z');

  it('gives a URL the same due date on every run', () => {
    const url = 'https://ebikeshop.hu/termek/ktm-macina-style-820-46-cm';
    expect(detailRefreshLead(url, SIXTY_DAYS)).toBe(detailRefreshLead(url, SIXTY_DAYS));
  });

  // Never later than the interval, provided a run sees the card.
  it('makes every listing due between 75% and 100% of the interval', () => {
    for (const url of ebikeshopLikeUrls(605)) {
      const age = detailRefreshDueAt({ url, lastUpdated, intervalMs: SIXTY_DAYS }).getTime() - lastUpdated.getTime();
      expect(age).toBeGreaterThan(45 * DAY);
      expect(age).toBeLessThanOrEqual(SIXTY_DAYS);
    }
  });

  // A first import writes the whole shop at once. With one deadline, all of it
  // would fall due on the same night; spread, a nightly run fetches ~40.
  it('spreads a first import of 605 listings evenly over days 45–60', () => {
    const perDay = new Map<number, number>();
    for (const url of ebikeshopLikeUrls(605)) {
      const due = detailRefreshDueAt({ url, lastUpdated, intervalMs: SIXTY_DAYS });
      const day = Math.floor((due.getTime() - lastUpdated.getTime()) / DAY);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }

    expect([...perDay.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, index) => 45 + index),
    );
    const mean = 605 / 15;
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(1.5 * mean);
  });
});
