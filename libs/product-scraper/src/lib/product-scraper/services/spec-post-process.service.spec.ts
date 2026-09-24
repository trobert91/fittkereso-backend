import { SpecPostProcessService } from './spec-post-process.service';
import { ProductSourcePostProcessMergeService } from '@fittkereso-backend/product';
import type {
  ProductSource,
  ProductSourceRecord,
  ScrapedProduct,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';

describe('SpecPostProcessService', () => {
  let service: SpecPostProcessService;
  let categoryConfigService: {
    getJsonSchema: jest.Mock;
    getConfig: jest.Mock;
    getGoldenSample: jest.Mock;
  };
  let postProcess: { extractIdentity: jest.Mock; processModelSpecs: jest.Mock };
  let metrics: {
    identityExtraction: jest.Mock;
    identitySpecRowsMatched: jest.Mock;
    specUnification: jest.Mock;
  };

  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {
      modelYear: { type: 'number', title: 'Model year' },
      batteryCapacity: { type: 'number', title: 'Battery' },
      weight: { type: 'number', title: 'Weight' },
      frameSize: { type: 'number', title: 'Frame size' },
      color: { type: 'string', title: 'Color' },
      forkTravel: { type: 'number', title: 'Fork travel' },
      tubeless: { type: 'boolean', title: 'Tubeless' },
    },
  };
  const golden = { modelYear: 2024, forkTravel: 140, tubeless: true };

  const rawSpecs = [
    { name: 'Motor', values: ['Bosch Performance CX'] },
    { name: 'Akkumulátor', values: ['Bosch PowerTube 750 Wh'] },
    { name: 'Fékbetét', values: ['Shimano J05A'] },
  ];

  /** What an importer hands the updater: deterministic data only. */
  const listing = (overrides: Partial<ScrapedProduct> = {}): ScrapedProduct => ({
    brand: 'KTM',
    model: "KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE",
    displayName: "KTM KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE",
    originalName: "KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE",
    category: { id: 'cat-1', slug: 'ebikes', name: 'E-bikes' },
    specs: { weight: 24 },
    extractedSpecs: { weight: 24, forkTravel: 150 },
    offerSpecsHash: 'offer-hash',
    productSpecsHash: 'product-hash',
    rawSpecs,
    description: 'Könnyű, strapabíró.',
    offers: [{ price: 1, externalId: 'sku-43' }],
    ...overrides,
  });

  const context = (
    config: Record<string, unknown> = {},
    force = false,
  ): ProductImportContext => ({
    url: 'https://speedbike.hu/ktm-macina',
    force,
    source: {
      id: 'source-1',
      name: 'speedbike-arukereso',
      config: { feedUrl: 'https://speedbike.hu/feed', mapping: {}, ...config },
    } as unknown as ProductSource,
  });

  beforeEach(() => {
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(schema),
      getConfig: jest.fn().mockReturnValue({
        primarySpecs: ['modelYear', 'batteryCapacity'],
        matcherSpecs: ['weight', 'notInSchema'],
        offerLevelSpecs: ['frameSize', 'color'],
      }),
      getGoldenSample: jest.fn().mockReturnValue(golden),
    };
    postProcess = {
      extractIdentity: jest.fn().mockResolvedValue({
        model: 'Macina Scarp SX Prestige Di2',
        specs: { modelYear: 2026, batteryCapacity: 750, frameSize: 43, color: 'Olíva' },
      }),
      processModelSpecs: jest.fn().mockResolvedValue({ specs: { tubeless: true } }),
    };
    metrics = {
      identityExtraction: jest.fn(),
      identitySpecRowsMatched: jest.fn(),
      specUnification: jest.fn(),
    };

    service = new SpecPostProcessService(
      categoryConfigService as never,
      postProcess as never,
      new ProductSourcePostProcessMergeService(),
      metrics as never,
    );
  });

  describe('scopesOf', () => {
    it('splits the schema by the category config: identity fields, and everything else', () => {
      expect(service.scopesOf('ebikes', schema)).toEqual({
        // A configured key the schema lacks is left out.
        identityKeys: ['modelYear', 'batteryCapacity', 'weight', 'frameSize', 'color'],
        offerLevelKeys: ['frameSize', 'color'],
        unificationKeys: ['forkTravel', 'tubeless'],
      });
    });
  });

  describe('extractIdentity', () => {
    it('asks for the identity fields, from the raw title, their deterministic values and the selected rows', async () => {
      await service.extractIdentity({
        context: context({ identityExtraction: { specRows: ['motor', 'Akkumulátor'] } }),
        scrapedProduct: listing(),
      });

      expect(postProcess.extractIdentity).toHaveBeenCalledWith({
        data: {
          brand: 'KTM',
          model: "KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE",
          // forkTravel is deterministic too, but not an identity field.
          specs: { weight: 24 },
        },
        rawSpecs: [rawSpecs[0], rawSpecs[1]],
        description: undefined,
        schema,
        outputKeys: ['modelYear', 'batteryCapacity', 'weight', 'frameSize', 'color'],
        offerLevelSpecs: ['frameSize', 'color'],
        model: undefined,
        thinking: undefined,
        effort: undefined,
        maxTokens: undefined,
      });
      expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'extracted');
      // The drift guard: a source whose labels change stops matching rows.
      expect(metrics.identitySpecRowsMatched).toHaveBeenCalledWith('speedbike-arukereso', 2);
    });

    it('sends the whole table when the source names no rows', async () => {
      await service.extractIdentity({ context: context(), scrapedProduct: listing() });

      expect(postProcess.extractIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ rawSpecs }),
      );
      expect(metrics.identitySpecRowsMatched).not.toHaveBeenCalled();
    });

    it('puts product-level values on the listing and listing-level values on its offers', async () => {
      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing(),
      });

      expect(result).toMatchObject({
        model: 'Macina Scarp SX Prestige Di2',
        displayName: 'KTM Macina Scarp SX Prestige Di2',
        originalName: "KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE",
        nameCleaned: true,
        specs: { modelYear: 2026, batteryCapacity: 750, weight: 24, forkTravel: 150 },
        offers: [{ price: 1, externalId: 'sku-43', specs: { frameSize: 43, color: 'Olíva' } }],
      });
      expect(result.specs).not.toHaveProperty('frameSize');
      expect(result.identityInputHash).toEqual(expect.any(String));
    });

    // A page listing several variants gives each offer its own size.
    it('keeps an offer\'s own listing-level specs', async () => {
      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing({
          offers: [
            { price: 1, specs: { frameSize: 48 } },
            { price: 2 },
          ],
        }),
      });

      expect(result.offers?.map((offer) => offer.specs)).toEqual([
        { frameSize: 48 },
        { frameSize: 43, color: 'Olíva' },
      ]);
    });

    it('forwards the description only when the source opts in', async () => {
      await service.extractIdentity({
        context: context({ postProcess: { includeDescriptionInOfferIdentity: true } }),
        scrapedProduct: listing(),
      });

      expect(postProcess.extractIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Könnyű, strapabíró.' }),
      );
    });

    it('continues on the deterministic data when the LLM fails, with the name marked uncleaned', async () => {
      postProcess.extractIdentity.mockResolvedValueOnce(undefined);

      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing(),
      });

      expect(result.model).toBe("KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE");
      expect(result.nameCleaned).toBe(false);
      expect(result.specs).toEqual({ weight: 24, forkTravel: 150 });
      expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'failed');
    });

    it('makes no call for a source that turned post-processing off', async () => {
      const result = await service.extractIdentity({
        context: context({ postProcess: { enabled: false } }),
        scrapedProduct: listing(),
      });

      expect(postProcess.extractIdentity).not.toHaveBeenCalled();
      expect(result.nameCleaned).toBe(false);
      expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'disabled');
    });

    describe('on a re-import', () => {
      /** This listing's record, as the first import left it. */
      const storedRecord = async (): Promise<ProductSourceRecord> => {
        const first = await service.extractIdentity({
          context: context(),
          scrapedProduct: listing(),
        });
        postProcess.extractIdentity.mockClear();
        metrics.identityExtraction.mockClear();
        return {
          offerSpecsHash: 'offer-hash',
          productSpecsHash: 'product-hash',
          scrapedProduct: {
            ...first,
            // What unification added when the product was created.
            specs: { ...first.specs, tubeless: true },
          },
        } as unknown as ProductSourceRecord;
      };

      it('reuses the stored extraction without a call when nothing it reads has changed', async () => {
        const ownRecord = await storedRecord();

        const result = await service.extractIdentity({
          context: context(),
          scrapedProduct: listing({ offers: [{ price: 2, externalId: 'sku-43' }] }),
          ownRecord,
        });

        expect(postProcess.extractIdentity).not.toHaveBeenCalled();
        expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'reused');
        expect(result).toMatchObject({
          model: 'Macina Scarp SX Prestige Di2',
          nameCleaned: true,
          specs: expect.objectContaining({ modelYear: 2026, tubeless: true }),
          // Today's price, the stored listing-level specs.
          offers: [{ price: 2, externalId: 'sku-43', specs: { frameSize: 43, color: 'Olíva' } }],
        });
      });

      // speedbike's deterministic mapping fills one field, so both spec
      // hashes can stay equal while the title and spec table change.
      it('extracts again when the title changed, though the deterministic hashes did not', async () => {
        const ownRecord = await storedRecord();

        const result = await service.extractIdentity({
          context: context(),
          scrapedProduct: listing({ originalName: "KTM MACINA SCARP SX PRESTIGE Di2 M/43 '27 OLIVE" }),
          ownRecord,
        });

        expect(postProcess.extractIdentity).toHaveBeenCalled();
        // Unification does not re-run for a source that already contributed,
        // so its fields on this record are kept.
        expect(result.specs).toMatchObject({ tubeless: true, modelYear: 2026 });
      });

      it('extracts again when a deterministic hash changed', async () => {
        const ownRecord = await storedRecord();

        await service.extractIdentity({
          context: context(),
          scrapedProduct: listing({ productSpecsHash: 'changed' }),
          ownRecord,
        });

        expect(postProcess.extractIdentity).toHaveBeenCalled();
      });

      it('never reuses under force', async () => {
        const ownRecord = await storedRecord();

        await service.extractIdentity({
          context: context({}, true),
          scrapedProduct: listing(),
          ownRecord,
        });

        expect(postProcess.extractIdentity).toHaveBeenCalled();
      });
    });
  });

  describe('unify', () => {
    const extracted = async () =>
      service.extractIdentity({ context: context(), scrapedProduct: listing() });

    it('fills every other schema field, with the identity values as context and the golden sample as example', async () => {
      await service.unify({
        context: context(),
        scrapedProduct: await extracted(),
        trigger: 'created',
      });

      expect(postProcess.processModelSpecs).toHaveBeenCalledWith({
        data: {
          brand: 'KTM',
          model: "KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE",
          specs: { forkTravel: 150 },
        },
        knownSpecs: {
          batteryCapacity: 750,
          color: 'Olíva',
          frameSize: 43,
          modelYear: 2026,
          weight: 24,
        },
        // The whole table: unification reads every row, not just the identity ones.
        rawSpecs,
        description: 'Könnyű, strapabíró.',
        schema,
        outputKeys: ['forkTravel', 'tubeless'],
        goldenSample: golden,
        model: undefined,
        thinking: undefined,
        effort: undefined,
        maxTokens: undefined,
      });
      expect(metrics.specUnification).toHaveBeenCalledWith('speedbike-arukereso', 'created', 'ok');
    });

    it('extends the listing\'s specs, never overwriting an identity value', async () => {
      postProcess.processModelSpecs.mockResolvedValueOnce({
        specs: { tubeless: true, modelYear: 1999 },
      });

      const result = await service.unify({
        context: context(),
        scrapedProduct: await extracted(),
        trigger: 'new_source',
      });

      expect(result.specs).toMatchObject({ tubeless: true, modelYear: 2026 });
    });

    it('leaves the listing as it was when the call fails', async () => {
      postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
      const before = await extracted();

      const result = await service.unify({
        context: context(),
        scrapedProduct: before,
        trigger: 'new_source',
      });

      expect(result).toBe(before);
      expect(metrics.specUnification).toHaveBeenCalledWith(
        'speedbike-arukereso',
        'new_source',
        'failed',
      );
    });

    it('withholds the description from a source that opted out', async () => {
      await service.unify({
        context: context({ postProcess: { includeDescriptionInModelSpecs: false } }),
        scrapedProduct: await extracted(),
        trigger: 'created',
      });

      expect(postProcess.processModelSpecs).toHaveBeenCalledWith(
        expect.objectContaining({ description: undefined }),
      );
    });

    it('makes no call for a source that turned post-processing off', async () => {
      await service.unify({
        context: context({ postProcess: { enabled: false } }),
        scrapedProduct: listing(),
        trigger: 'created',
      });

      expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
      expect(metrics.specUnification).toHaveBeenCalledWith(
        'speedbike-arukereso',
        'created',
        'disabled',
      );
    });
  });
});
