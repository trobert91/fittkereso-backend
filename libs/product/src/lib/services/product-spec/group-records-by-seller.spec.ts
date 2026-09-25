import type { ProductSourceRecord } from '@fittkereso-backend/database';
import { groupRecordsBySeller } from './group-records-by-seller';

const record = (params: {
  id: string;
  sourceId?: string | null;
  sellerId?: string | null;
  priority?: number;
  specs: Record<string, unknown>;
  lastUpdated: string;
}): ProductSourceRecord =>
  ({
    id: params.id,
    source:
      params.sourceId === null
        ? null
        : {
            id: params.sourceId ?? params.id,
            priority: params.priority ?? 10,
            seller: params.sellerId === null ? undefined : { id: params.sellerId ?? 'seller-1' },
          },
    scrapedProduct: { specs: params.specs },
    lastUpdated: new Date(params.lastUpdated),
  }) as unknown as ProductSourceRecord;

describe('groupRecordsBySeller', () => {
  it('returns a seller\'s only record as it is', () => {
    const only = record({ id: 'a', specs: { weight: 22 }, lastUpdated: '2026-09-20' });

    expect(groupRecordsBySeller([only])).toEqual([only]);
  });

  // ebikeshop's three size pages: same source, same priority.
  it('takes each key from the newest record on a priority tie', () => {
    const [candidate] = groupRecordsBySeller([
      record({ id: 'old', sourceId: 's', specs: { weight: 22, battery: 625 }, lastUpdated: '2026-09-01' }),
      record({ id: 'new', sourceId: 's', specs: { weight: 23 }, lastUpdated: '2026-09-20' }),
    ]);

    expect(candidate.scrapedProduct?.specs).toEqual({ weight: 23, battery: 625 });
    expect(candidate.lastUpdated).toEqual(new Date('2026-09-20'));
  });

  it('skips empty values, so a lower record can fill them', () => {
    const [candidate] = groupRecordsBySeller([
      record({ id: 'high', priority: 60, specs: { display: '' }, lastUpdated: '2026-09-20' }),
      record({ id: 'low', priority: 40, specs: { display: 'Kiox 300' }, lastUpdated: '2026-09-20' }),
    ]);

    expect(candidate.scrapedProduct?.specs).toEqual({ display: 'Kiox 300' });
  });

  it('keeps the newest admin record as a candidate of its own', () => {
    const listing = record({ id: 'a', specs: { weight: 22 }, lastUpdated: '2026-09-20' });
    const olderManual = record({ id: 'm1', sourceId: null, specs: { weight: 20 }, lastUpdated: '2026-01-01' });
    const manual = record({ id: 'm2', sourceId: null, specs: { weight: 21 }, lastUpdated: '2026-09-01' });

    expect(groupRecordsBySeller([olderManual, listing, manual])).toEqual([listing, manual]);
  });

  it('counts a record whose seller is not loaded as a seller of its own', () => {
    const candidates = groupRecordsBySeller([
      record({ id: 'a', sellerId: null, specs: { weight: 22 }, lastUpdated: '2026-09-20' }),
      record({ id: 'b', sellerId: null, specs: { weight: 23 }, lastUpdated: '2026-09-20' }),
    ]);

    expect(candidates).toHaveLength(2);
  });
});
