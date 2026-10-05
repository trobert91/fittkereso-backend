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

  /** What an importer hands the updater: deterministic data only, and no name but the title. */
  const listing = (overrides: Partial<ScrapedProduct> = {}): ScrapedProduct => ({
    brand: 'KTM',
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
        // The offer-level specs are always left out of the model.
        modelRule: { excludedKeys: ['frameSize', 'color'] },
        promptExamples: undefined,
        // A category without evidence keywords cuts no excerpts.
        evidenceKeywords: [],
      });
    });
  });

  describe('extractIdentity', () => {
    it('asks for the identity fields, from the raw title, their deterministic values and the selected rows', async () => {
      await service.extractIdentity({
        context: context({
          categories: { ebikes: { enabled: true, identitySpecRows: ['motor', 'Akkumulátor'] } },
        }),
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
        modelRule: { excludedKeys: ['frameSize', 'color'] },
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
        originalName: "KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE",
        specs: { modelYear: 2026, batteryCapacity: 750, weight: 24, forkTravel: 150 },
        offers: [{ price: 1, externalId: 'sku-43', specs: { frameSize: 43, color: 'Olíva' } }],
      });
      expect(result.flags).toBeUndefined();
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

    describe("the description, by the source's identityDescription mode", () => {
      const trekking =
        '<h2>KTM Macina Style 720 elektromos trekking kerékpár</h2><p>A Bosch 2026 újdonságai mindenhol.</p>';
      const withKeywords = (evidenceKeywords: string[]) => {
        const config = categoryConfigService.getConfig();
        categoryConfigService.getConfig.mockReturnValue({ ...config, evidenceKeywords });
      };
      const sent = () => postProcess.extractIdentity.mock.calls[0][0];

      it('sends none of it by default', async () => {
        await service.extractIdentity({ context: context(), scrapedProduct: listing() });

        expect(sent().description).toBeUndefined();
        expect(sent().descriptionEvidence).toBeUndefined();
      });

      it('sends all of it in full mode', async () => {
        await service.extractIdentity({
          context: context({ postProcess: { identityDescription: { mode: 'full' } } }),
          scrapedProduct: listing(),
        });

        expect(sent().description).toBe('Könnyű, strapabíró.');
        expect(sent().descriptionEvidence).toBeUndefined();
      });

      it("sends the text around the category's keywords in evidence mode", async () => {
        withKeywords(['trekking']);

        await service.extractIdentity({
          context: context({
            postProcess: { identityDescription: { mode: 'evidence', windowWords: 2 } },
          }),
          scrapedProduct: listing({ description: trekking }),
        });

        expect(sent().description).toBeUndefined();
        expect(sent().descriptionEvidence).toEqual(['720 elektromos trekking kerékpár A']);
      });

      // Switching a source to evidence re-asks only the listings it gives excerpts.
      it('asks a listing whose description has no keyword as it did before', async () => {
        withKeywords(['gravel']);
        const asBefore = await service.extractIdentity({
          context: context(),
          scrapedProduct: listing({ description: trekking }),
        });
        const inEvidenceMode = await service.extractIdentity({
          context: context({ postProcess: { identityDescription: { mode: 'evidence' } } }),
          scrapedProduct: listing({ description: trekking }),
        });

        expect(postProcess.extractIdentity.mock.calls[1][0].descriptionEvidence).toBeUndefined();
        expect(inEvidenceMode.identityInputHash).toBe(asBefore.identityInputHash);
      });
    });

    it('continues on the deterministic data when the LLM fails, with no name and the failure flagged', async () => {
      postProcess.extractIdentity.mockResolvedValueOnce(undefined);

      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing(),
      });

      expect(result.model).toBeUndefined();
      expect(result.originalName).toBe("KTM MACINA SCARP SX PRESTIGE Di2 M/43 '26 OLIVE");
      expect(result.flags).toEqual(['identity_failed']);
      expect(result.specs).toEqual({ weight: 24, forkTravel: 150 });
      expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'failed');
    });

    // A brand alone names nothing.
    it('flags a call that corrected only the brand as failed', async () => {
      postProcess.extractIdentity.mockResolvedValueOnce({ brand: 'KTM AG' });

      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing(),
      });

      expect(result).toMatchObject({ brand: 'KTM AG', flags: ['identity_failed'] });
      expect(result.model).toBeUndefined();
    });

    it('makes no call for a source that turned the identity extraction off, and flags it', async () => {
      const result = await service.extractIdentity({
        context: context({ postProcess: { identity: false } }),
        scrapedProduct: listing(),
      });

      expect(postProcess.extractIdentity).not.toHaveBeenCalled();
      expect(result.model).toBeUndefined();
      expect(result.flags).toEqual(['identity_off']);
      expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'disabled');
    });

    it('still extracts with unification off', async () => {
      const result = await service.extractIdentity({
        context: context({ postProcess: { specs: false } }),
        scrapedProduct: listing(),
      });

      expect(postProcess.extractIdentity).toHaveBeenCalled();
      expect(result.model).toBe('Macina Scarp SX Prestige Di2');
    });

    describe('the model rule', () => {
      it('asks for the model leaving out the offer-level and the configured specs, with the category examples', async () => {
        const examples = [{ title: 'KTM Macina Style 810 Di2 46cm', model: 'Macina Style 810 Di2' }];
        categoryConfigService.getConfig.mockReturnValue({
          primarySpecs: ['modelYear', 'batteryCapacity'],
          offerLevelSpecs: ['frameSize', 'color'],
          matchingConfig: { model: { excludeSpecs: ['modelYear', 'notInSchema'], examples } },
        });

        await service.extractIdentity({ context: context(), scrapedProduct: listing() });

        expect(postProcess.extractIdentity).toHaveBeenCalledWith(
          expect.objectContaining({
            modelRule: { excludedKeys: ['frameSize', 'color', 'modelYear'], examples },
          }),
        );
      });

      it('stores the model with the contract it was asked under', async () => {
        const result = await service.extractIdentity({ context: context(), scrapedProduct: listing() });

        expect(result.model).toBe('Macina Scarp SX Prestige Di2');
        expect(result.modelContract).toBe(service.modelContractOf('ebikes'));
      });

      it('has no contract when the call failed, or for a source with the extraction off', async () => {
        postProcess.extractIdentity.mockResolvedValueOnce(undefined);
        const failed = await service.extractIdentity({ context: context(), scrapedProduct: listing() });
        const off = await service.extractIdentity({
          context: context({ postProcess: { identity: false } }),
          scrapedProduct: listing(),
        });

        expect(failed.modelContract).toBeUndefined();
        expect(off.modelContract).toBeUndefined();
      });

      // The contract follows the rule: other left-out specs or examples ask again.
      it('changes its contract with the left-out specs', () => {
        const before = service.modelContractOf('ebikes');
        categoryConfigService.getConfig.mockReturnValue({
          offerLevelSpecs: ['frameSize', 'color'],
          matchingConfig: { model: { excludeSpecs: ['modelYear'] } },
        });

        expect(service.modelContractOf('ebikes')).not.toBe(before);
      });
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
          specs: expect.objectContaining({ modelYear: 2026, tubeless: true }),
          // Today's price, the stored listing-level specs.
          offers: [{ price: 2, externalId: 'sku-43', specs: { frameSize: 43, color: 'Olíva' } }],
        });
        expect(result.flags).toBeUndefined();
      });

      // A stored failure is nothing to keep: the next import asks again.
      it('extracts again when the stored record has no model', async () => {
        postProcess.extractIdentity.mockResolvedValueOnce(undefined);
        const ownRecord = await storedRecord();
        expect(ownRecord.scrapedProduct?.flags).toEqual(['identity_failed']);

        const result = await service.extractIdentity({
          context: context(),
          scrapedProduct: listing(),
          ownRecord,
        });

        expect(postProcess.extractIdentity).toHaveBeenCalled();
        expect(result.model).toBe('Macina Scarp SX Prestige Di2');
        expect(result.flags).toBeUndefined();
      });

      // Turned on later, the extraction names a listing stored while it was off.
      it('names a listing stored while the extraction was off once it is on', async () => {
        const first = await service.extractIdentity({
          context: context({ postProcess: { identity: false } }),
          scrapedProduct: listing(),
        });
        const ownRecord = {
          offerSpecsHash: 'offer-hash',
          productSpecsHash: 'product-hash',
          scrapedProduct: first,
        } as unknown as ProductSourceRecord;

        const result = await service.extractIdentity({
          context: context(),
          scrapedProduct: listing(),
          ownRecord,
        });

        expect(postProcess.extractIdentity).toHaveBeenCalled();
        expect(result.model).toBe('Macina Scarp SX Prestige Di2');
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

      describe('a model asked under an older rule', () => {
        const refreshed = {
          model: 'MACINA SCARP SX PRESTIGE Di2',
          specs: { modelYear: 2027, batteryCapacity: 625 },
        };
        const storedUnder = async (contract: string | undefined) => {
          const ownRecord = await storedRecord();
          ownRecord.scrapedProduct = { ...ownRecord.scrapedProduct, modelContract: contract };
          return ownRecord;
        };

        it('asks again for the model alone, keeping the stored specs', async () => {
          const ownRecord = await storedUnder('old');
          postProcess.extractIdentity.mockResolvedValueOnce(refreshed);

          const result = await service.extractIdentity({
            context: context(),
            scrapedProduct: listing(),
            ownRecord,
          });

          expect(postProcess.extractIdentity).toHaveBeenCalledTimes(1);
          expect(result.model).toBe('MACINA SCARP SX PRESTIGE Di2');
          expect(result.modelContract).toBe(service.modelContractOf('ebikes'));
          expect(result.specs).toMatchObject({ modelYear: 2026, batteryCapacity: 750, tubeless: true });
          expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'refreshed');
          expect(metrics.identityExtraction).not.toHaveBeenCalledWith('speedbike-arukereso', 'reused');
        });

        // A word the old model kept (a frame word, say) is compared as its
        // spec value once the new rule leaves it out, so it is not lost.
        it('takes the values of the specs the model now leaves out, where the stored listing has none', async () => {
          categoryConfigService.getConfig.mockReturnValue({
            primarySpecs: ['modelYear', 'batteryCapacity'],
            matcherSpecs: ['weight'],
            offerLevelSpecs: ['frameSize', 'color'],
            matchingConfig: { model: { excludeSpecs: ['modelYear', 'batteryCapacity'] } },
          });
          const ownRecord = await storedUnder('old');
          const { batteryCapacity, weight, ...storedSpecs } = ownRecord.scrapedProduct?.specs ?? {};
          expect([batteryCapacity, weight]).toEqual([750, 24]);
          ownRecord.scrapedProduct = { ...ownRecord.scrapedProduct, specs: storedSpecs } as ScrapedProduct;
          postProcess.extractIdentity.mockResolvedValueOnce({
            model: 'MACINA SCARP SX PRESTIGE Di2',
            specs: { modelYear: 2027, batteryCapacity: 625, weight: 30, frameSize: 46 },
          });

          const result = await service.extractIdentity({
            context: context(),
            scrapedProduct: listing(),
            ownRecord,
          });

          // The stored year wins; a spec the model keeps, or an offer-level
          // one, is not taken.
          expect(result.specs).toMatchObject({ modelYear: 2026, batteryCapacity: 625, tubeless: true });
          expect(result.specs).not.toHaveProperty('weight');
          expect(result.specs).not.toHaveProperty('frameSize');
        });

        // Stored before models had contracts.
        it('asks again for a model stored without a contract', async () => {
          const ownRecord = await storedUnder(undefined);
          postProcess.extractIdentity.mockResolvedValueOnce(refreshed);

          const result = await service.extractIdentity({
            context: context(),
            scrapedProduct: listing(),
            ownRecord,
          });

          expect(result.model).toBe('MACINA SCARP SX PRESTIGE Di2');
        });

        it('keeps the stored model after a failed call, so the next import asks again', async () => {
          const ownRecord = await storedUnder('old');
          postProcess.extractIdentity.mockResolvedValueOnce(undefined);

          const result = await service.extractIdentity({
            context: context(),
            scrapedProduct: listing(),
            ownRecord,
          });

          expect(result.model).toBe('Macina Scarp SX Prestige Di2');
          expect(result.modelContract).toBe('old');
          expect(result.flags).toBeUndefined();
          expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'refresh_failed');
        });

        it('asks nothing for a source that turned the extraction off since', async () => {
          const ownRecord = await storedUnder('old');

          await service.extractIdentity({
            context: context({ postProcess: { identity: false } }),
            scrapedProduct: listing(),
            ownRecord,
          });

          expect(postProcess.extractIdentity).not.toHaveBeenCalled();
        });

        // A contributing source's listing names no product and is matched on nothing.
        it('asks nothing for a source that does not identify products', async () => {
          const ownRecord = await storedUnder('old');
          const contributing = context();
          contributing.source = { ...contributing.source, identifiesProducts: false } as ProductSource;

          const result = await service.extractIdentity({
            context: contributing,
            scrapedProduct: listing(),
            ownRecord,
          });

          expect(postProcess.extractIdentity).not.toHaveBeenCalled();
          expect(result.model).toBe('Macina Scarp SX Prestige Di2');
          expect(metrics.identityExtraction).toHaveBeenCalledWith('speedbike-arukereso', 'reused');
        });
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

    it('makes no call for a source that turned unification off', async () => {
      await service.unify({
        context: context({ postProcess: { specs: false } }),
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

    it('still unifies with the identity extraction off', async () => {
      await service.unify({
        context: context({ postProcess: { identity: false } }),
        scrapedProduct: listing(),
        trigger: 'created',
      });

      expect(postProcess.processModelSpecs).toHaveBeenCalled();
    });
  });

  // What these return is what identity matching compares and the source
  // record stores, so a year arrives in one form whichever piece it came from
  // — including pieces the spec normaliser never sees.
  describe('years', () => {
    const yearSchema: SpecDefinitionJsonSchema = {
      ...schema,
      properties: {
        ...schema.properties,
        modelYear: { type: 'number', title: 'Model year', meta: { format: 'year' } },
      },
    };

    beforeEach(() => {
      categoryConfigService.getJsonSchema.mockReturnValue(yearSchema);
      postProcess.extractIdentity.mockResolvedValue({
        model: 'Macina Scarp SX Prestige Di2',
        specs: { batteryCapacity: 750 },
      });
    });

    it('normalises a deterministic year the LLM did not replace', async () => {
      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing({ extractedSpecs: { weight: 24, modelYear: "'26" } }),
      });

      expect(result.specs).toMatchObject({ modelYear: 2026, batteryCapacity: 750 });
    });

    it('normalises the year with the identity extraction off', async () => {
      const result = await service.extractIdentity({
        context: context({ postProcess: { identity: false } }),
        scrapedProduct: listing({ extractedSpecs: { modelYear: '26' } }),
      });

      expect(result.specs).toMatchObject({ modelYear: 2026 });
    });

    // Another category may keep a year on the offer.
    it('normalises a year in an offer\'s own specs', async () => {
      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing({
          offers: [{ price: 1, externalId: 'sku-43', specs: { frameSize: 43, modelYear: "'26" } }],
        }),
      });

      expect(result.offers?.[0].specs).toEqual({ frameSize: 43, modelYear: 2026 });
    });

    it('normalises a year reused from the stored record', async () => {
      const first = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing(),
      });
      postProcess.extractIdentity.mockClear();
      const ownRecord = {
        offerSpecsHash: 'offer-hash',
        productSpecsHash: 'product-hash',
        // Stored before years were normalised.
        scrapedProduct: { ...first, specs: { ...first.specs, modelYear: '2026.' } },
      } as unknown as ProductSourceRecord;

      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing(),
        ownRecord,
      });

      expect(postProcess.extractIdentity).not.toHaveBeenCalled();
      expect(result.specs).toMatchObject({ modelYear: 2026 });
    });

    it('normalises the year on the unified listing', async () => {
      const result = await service.unify({
        context: context(),
        scrapedProduct: listing({ specs: { weight: 24, modelYear: "'26" } }),
        trigger: 'created',
      });

      expect(result.specs).toEqual({ weight: 24, modelYear: 2026, tubeless: true });
    });

    it('drops a year that is not one year', async () => {
      const result = await service.extractIdentity({
        context: context(),
        scrapedProduct: listing({ extractedSpecs: { weight: 24, modelYear: '2025/2026' } }),
      });

      expect(result.specs).not.toHaveProperty('modelYear');
    });
  });
});
