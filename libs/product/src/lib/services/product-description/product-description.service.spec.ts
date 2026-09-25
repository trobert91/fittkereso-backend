import { ProductSourceRecord } from '@fittkereso-backend/database';
import { MIN_DESCRIPTION_LENGTH, ProductDescriptionService } from './product-description.service';

describe('ProductDescriptionService', () => {
  const service = new ProductDescriptionService();

  const text = (label: string, length = 60) => `${label} `.padEnd(length, 'x');
  const record = (params: {
    id?: string;
    sourceId?: string;
    priority?: number;
    description?: string;
    lastUpdated?: Date;
  }) =>
    ({
      id: params.id ?? `record-${params.sourceId ?? 'admin'}`,
      source: params.sourceId ? { id: params.sourceId, priority: params.priority ?? 10 } : null,
      scrapedProduct: params.description === undefined ? {} : { description: params.description },
      lastUpdated: params.lastUpdated ?? new Date('2026-09-01'),
    }) as unknown as ProductSourceRecord;

  it("takes the admin's own description over every source", () => {
    expect(
      service.pick([
        record({ sourceId: 'arukereso', priority: 60, description: text('feed') }),
        record({ description: '  Az admin szövege.  ' }),
      ]),
    ).toBe('Az admin szövege.');
  });

  it('takes the newest admin record when there are several', () => {
    expect(
      service.pick([
        record({ id: 'old', description: 'régi', lastUpdated: new Date('2026-01-01') }),
        record({ id: 'new', description: 'új', lastUpdated: new Date('2026-09-01') }),
      ]),
    ).toBe('új');
  });

  it('takes the highest-priority source, as plain text', () => {
    expect(
      service.pick([
        record({ sourceId: 'google', priority: 40, description: text('google', 200) }),
        record({ sourceId: 'arukereso', priority: 60, description: `<p>${text('feed')}</p>` }),
      ]),
    ).toBe(text('feed'));
  });

  // speedbike's Árukereső feed: only the article number, so Google's text is the description.
  it(`skips a text under ${MIN_DESCRIPTION_LENGTH} characters`, () => {
    expect(
      service.pick([
        record({ sourceId: 'arukereso', priority: 60, description: '<p>121210</p>' }),
        record({ sourceId: 'google', priority: 40, description: text('google') }),
      ]),
    ).toBe(text('google'));
  });

  it('skips an admin record without a description', () => {
    expect(
      service.pick([
        record({ description: '   ' }),
        record({ sourceId: 'arukereso', priority: 60, description: text('feed') }),
      ]),
    ).toBe(text('feed'));
  });

  it('takes the longer text among equal priorities, measured as plain text', () => {
    expect(
      service.pick([
        // Longer as HTML, shorter as text.
        record({ sourceId: 'shop-a', priority: 50, description: `<p style="${'x'.repeat(200)}">${text('a', 70)}</p>` }),
        record({ sourceId: 'shop-b', priority: 50, description: text('b', 80) }),
      ]),
    ).toBe(text('b', 80));
  });

  it('takes the lower source id when the texts are equally long', () => {
    const records = [
      record({ sourceId: 'shop-b', priority: 50, description: text('b') }),
      record({ sourceId: 'shop-a', priority: 50, description: text('a') }),
    ];
    expect(service.pick(records)).toBe(text('a'));
    expect(service.pick([...records].reverse())).toBe(text('a'));
  });

  // A product's sizes, listed by one source: record ids are random, URLs are not.
  it('takes the lower listing URL within one source when the texts are equally long', () => {
    const size = (url: string, label: string) =>
      Object.assign(record({ id: `record-${label}`, sourceId: 'arukereso', priority: 60, description: text(label) }), {
        url,
      });
    const records = [
      size('https://speedbike.hu/cube-ams-xl', 'a-xl'),
      size('https://speedbike.hu/cube-ams-l', 'z-l'),
    ];
    expect(service.pick(records)).toBe(text('z-l'));
    expect(service.pick([...records].reverse())).toBe(text('z-l'));
  });

  it('gives null when nothing has a description', () => {
    expect(service.pick([])).toBeNull();
    expect(
      service.pick([
        record({ sourceId: 'arukereso', priority: 60, description: '<p>121210</p>' }),
        record({ sourceId: 'google', priority: 40 }),
      ]),
    ).toBeNull();
  });
});
