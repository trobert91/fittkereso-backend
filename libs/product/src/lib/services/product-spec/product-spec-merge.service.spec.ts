import { ProductSpecMergeService } from './product-spec-merge.service';
import type {
  ProductSourceRecord,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';

describe('ProductSpecMergeService', () => {
  let service: ProductSpecMergeService;
  let sourceRepo: { getAll: jest.Mock };
  let categoryConfigService: {
    getJsonSchema: jest.Mock;
  };

  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {
      weight: { type: 'number', title: 'Weight', meta: { min: 8, max: 45 } },
      frameSize: { type: 'number', title: 'Frame size', meta: { min: 30, max: 70 } },
      brakeType: {
        type: 'string',
        title: 'Brake type',
        meta: {},
        enum: ['Tárcsa', 'Racker (Felni)'],
      },
      forkModel: { type: 'string', title: 'Fork model', meta: {} },
      motorModel: { type: 'string', title: 'Motor model', meta: {} },
      torque: { type: 'number', title: 'Torque', meta: {} },
      motorPower: { type: 'number', title: 'Motor power', meta: {} },
    },
  };

  function makeSource(
    id: string,
    specs: Record<string, unknown>,
    opts: { lastUpdated?: string; sourceName?: string } = {},
  ): ProductSourceRecord {
    return {
      id,
      source: { id } as any,
      sourceName: opts.sourceName ?? id,
      specs,
      lastUpdated: new Date(opts.lastUpdated ?? '2026-01-01T00:00:00Z'),
    } as unknown as ProductSourceRecord;
  }

  function setSourcePriorities(priorities: Record<string, number>) {
    sourceRepo.getAll.mockResolvedValue(
      Object.entries(priorities).map(([id, priority]) => ({ id, priority })),
    );
  }

  beforeEach(() => {
    sourceRepo = { getAll: jest.fn().mockResolvedValue([]) };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(schema),
    };
    service = new ProductSpecMergeService(
      sourceRepo as any,
      categoryConfigService as any,
    );
  });

  it('passes a single-source value through untouched', async () => {
    setSourcePriorities({ a: 0 });
    const result = await service.mergeSpecs(
      [makeSource('a', { weight: 22 })],
      'ebikes',
    );
    expect(result['weight']).toBe(22);
  });

  describe('Tier 1 — disqualification', () => {
    it('drops a numeric candidate outside meta.min/max', async () => {
      setSourcePriorities({ a: 0, b: 0 });
      // frameSize meta is [30, 70] cm — 17 is a plausible value only if
      // misreported in inches (as mangobike.hu does for this exact field).
      const result = await service.mergeSpecs(
        [
          makeSource('a', { frameSize: 17 }),
          makeSource('b', { frameSize: 43 }),
        ],
        'ebikes',
      );
      expect(result['frameSize']).toBe(43);
    });

    it('drops a string candidate outside the schema enum', async () => {
      setSourcePriorities({ a: 0, b: 0 });
      const result = await service.mergeSpecs(
        [
          makeSource('a', { brakeType: 'Shimano Deore XT' }), // a model, not a type
          makeSource('b', { brakeType: 'Tárcsa' }),
        ],
        'ebikes',
      );
      expect(result['brakeType']).toBe('Tárcsa');
    });

    it('fails open when every candidate would be disqualified', async () => {
      setSourcePriorities({ a: 0 });
      const result = await service.mergeSpecs(
        [makeSource('a', { frameSize: 1000 })],
        'ebikes',
      );
      expect(result['frameSize']).toBe(1000);
    });
  });

  describe('Tier 2 — corroboration', () => {
    it('picks the value the most sources agree on over a lone dissenter', async () => {
      setSourcePriorities({ a: 0, b: 0, c: 0 });
      const result = await service.mergeSpecs(
        [
          makeSource('a', { forkModel: 'FOX 36SL Float 29" Factory 140mm' }),
          makeSource('b', { forkModel: 'FOX 36SL Float 29" Factory 140mm' }),
          makeSource('c', { forkModel: 'FOX 36SL Float Factory' }), // truncated
        ],
        'ebikes',
      );
      expect(result['forkModel']).toBe('FOX 36SL Float 29" Factory 140mm');
    });

    it("is case/whitespace-insensitive when grouping, but keeps the winning group's own casing", async () => {
      setSourcePriorities({ a: 0, b: 0, c: 0 });
      const result = await service.mergeSpecs(
        [
          makeSource('a', { brakeType: 'Tárcsa' }),
          makeSource('b', { brakeType: ' tárcsa ' }),
          makeSource('c', { brakeType: 'Racker (Felni)' }),
        ],
        'ebikes',
      );
      // 2 corroborating sources for "tárcsa" (normalized) beat the 1-source
      // "Racker (Felni)"; the representative literal value is whichever
      // candidate in that group wins Tier 4 (most recent / highest priority).
      expect(['Tárcsa', ' tárcsa ']).toContain(result['brakeType']);
    });
  });

  describe('Tier 3 — numeric precision', () => {
    it("prefers the more precise value when it is within the coarser value's rounding tolerance", async () => {
      setSourcePriorities({ a: 0, b: 0 });
      const result = await service.mergeSpecs(
        [
          makeSource('a', { frameSize: 43 }),
          makeSource('b', { frameSize: 43.2 }),
        ],
        'ebikes',
      );
      expect(result['frameSize']).toBe(43.2);
    });

    it('leaves a real numeric disagreement unresolved by Tier 3, falling through to Tier 4', async () => {
      // 17 vs 17.6 kg differ by more than the ±0.5 rounding tolerance a
      // 0-decimal reading of 17.6 could produce — genuine disagreement, not
      // a precision split.
      setSourcePriorities({ a: 5, b: 10 });
      const result = await service.mergeSpecs(
        [
          makeSource('a', { weight: 17 }, { lastUpdated: '2026-01-01T00:00:00Z' }),
          makeSource('b', { weight: 17.6 }, { lastUpdated: '2026-01-01T00:00:00Z' }),
        ],
        'ebikes',
      );
      // Same recency -> falls to priority -> source b (priority 10) wins.
      expect(result['weight']).toBe(17.6);
    });
  });

  describe('Tier 4 — recency then priority', () => {
    it('prefers the most recently scraped value over a higher-priority but stale one', async () => {
      setSourcePriorities({ old: 100, fresh: 1 });
      const result = await service.mergeSpecs(
        [
          makeSource('old', { weight: 20 }, { lastUpdated: '2020-01-01T00:00:00Z' }),
          makeSource('fresh', { weight: 21 }, { lastUpdated: '2026-01-01T00:00:00Z' }),
        ],
        'ebikes',
      );
      expect(result['weight']).toBe(21);
    });

    it('falls back to ProductSource.priority only once recency ties', async () => {
      setSourcePriorities({ low: 1, high: 10 });
      const result = await service.mergeSpecs(
        [
          makeSource('low', { weight: 20 }, { lastUpdated: '2026-01-01T00:00:00Z' }),
          makeSource('high', { weight: 21 }, { lastUpdated: '2026-01-01T00:00:00Z' }),
        ],
        'ebikes',
      );
      expect(result['weight']).toBe(21);
    });
  });

  it('sorts the merged output alphabetically by key', async () => {
    setSourcePriorities({ a: 0 });
    const result = await service.mergeSpecs(
      [makeSource('a', { weight: 22, forkModel: 'x', torque: 55 })],
      'ebikes',
    );
    expect(Object.keys(result)).toEqual(['forkModel', 'torque', 'weight']);
  });

  it('omits keys with no defined value on any source', async () => {
    setSourcePriorities({ a: 0 });
    const result = await service.mergeSpecs(
      [makeSource('a', { weight: 22, torque: undefined })],
      'ebikes',
    );
    expect(result['torque']).toBeUndefined();
    expect('torque' in result).toBe(false);
  });
});
