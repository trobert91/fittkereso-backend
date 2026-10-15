import { SpecPostProcessService } from './spec-post-process.service';
import { ProductSourcePostProcessMergeService } from '@fittkereso-backend/product';
import { omit } from 'lodash';
import { specsKeyOf } from './listing-input-hashes';
import type {
  ProductModel,
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
      type: 'arukereso',
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
      // A feed listing without its feed part apart, or a page: its input is its feed's.
      expect(result.inputHashes).toEqual({ feedIdentity: expect.any(String), feedSpecs: expect.any(String) });
      expect(result).not.toHaveProperty('identityInputHash');
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
        expect(inEvidenceMode.inputHashes?.feedIdentity).toBe(asBefore.inputHashes?.feedIdentity);
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
        const { inputHashes, ...stored } = first;
        return {
          offerSpecsHash: 'offer-hash',
          productSpecsHash: 'product-hash',
          inputHashes,
          scrapedProduct: {
            ...stored,
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
          inputHashes: first.inputHashes,
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

      it('extracts again when a mapped identity value changed', async () => {
        const ownRecord = await storedRecord();

        await service.extractIdentity({
          context: context(),
          scrapedProduct: listing({ extractedSpecs: { weight: 25, forkTravel: 150 }, productSpecsHash: 'changed' }),
          ownRecord,
        });

        expect(postProcess.extractIdentity).toHaveBeenCalled();
      });

      // A fixed mapping of a field the identity extraction never reads asks it
      // nothing — and the listing still takes the newly mapped value.
      it('reuses the extraction when only a mapped non-identity value changed, taking the new value', async () => {
        const ownRecord = await storedRecord();

        const result = await service.extractIdentity({
          context: context(),
          scrapedProduct: listing({
            extractedSpecs: { weight: 24, forkTravel: 160 },
            productLevelDeterministicSpecs: { weight: 24, forkTravel: 160 },
            productSpecsHash: 'changed',
          }),
          ownRecord,
        });

        expect(postProcess.extractIdentity).not.toHaveBeenCalled();
        expect(result.specs).toMatchObject({ forkTravel: 160, tubeless: true, modelYear: 2026, weight: 24 });
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

      // The shop filed the listing under another category since: what was
      // read for the old one is that category's.
      it('neither reuses nor carries over a record made for another category', async () => {
        const ownRecord = await storedRecord();
        const stored = ownRecord.scrapedProduct as ScrapedProduct;
        ownRecord.scrapedProduct = {
          ...stored,
          category: { ...stored.category, id: 'category-bikes', slug: 'bikes' },
        };

        const result = await service.extractIdentity({
          context: context(),
          scrapedProduct: listing(),
          ownRecord,
        });

        expect(postProcess.extractIdentity).toHaveBeenCalled();
        expect(result.specs).not.toHaveProperty('tubeless');
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
        inputHashes: first.inputHashes,
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

  // A feed listing's input in two parts: what its feed row said, and what its
  // product page said. An import compares only what it read.
  describe('input hashes by part', () => {
    const pageRows = [{ name: 'Neme:', values: ['Férfi'] }];
    /** The feed row as mapped, before its page was merged in. */
    const feedRow = (overrides: Partial<ScrapedProduct> = {}) => listing(overrides);
    /** The listing with its page merged in: page rows after the feed's, page specs filling gaps. */
    const withPage = (feed: ScrapedProduct, page: Partial<NonNullable<ScrapedProduct['page']>> = {}) => {
      const stored = {
        url: 'https://speedbike.hu/ktm-macina',
        rawSpecs: pageRows,
        specs: { batteryCapacity: 750 },
        rowCount: 1,
        contentHash: 'page',
        ...page,
      };
      return {
        ...feed,
        rawSpecs: [...(feed.rawSpecs ?? []), ...stored.rawSpecs],
        extractedSpecs: { ...stored.specs, ...feed.extractedSpecs },
        page: stored,
      } as ScrapedProduct;
    };
    const pageImport = (feed: ScrapedProduct, listingWithPage: ScrapedProduct, ownRecord?: ProductSourceRecord) =>
      service.extractIdentity({
        context: { ...context(), feedListing: feed, pageRead: { fetchedAt: new Date() } },
        scrapedProduct: listingWithPage,
        ownRecord,
      });
    const feedOnlyImport = (feed: ScrapedProduct, listingWithPage: ScrapedProduct, ownRecord?: ProductSourceRecord) =>
      service.extractIdentity({
        context: { ...context(), feedListing: feed },
        scrapedProduct: listingWithPage,
        ownRecord,
      });
    /** The record an import left: its result, its hashes in their column. */
    const recordOf = (result: ScrapedProduct, before?: ProductSourceRecord): ProductSourceRecord => {
      const { inputHashes, ...stored } = result;
      return {
        offerSpecsHash: result.offerSpecsHash,
        productSpecsHash: result.productSpecsHash,
        inputHashes: { ...(before?.inputHashes ?? {}), ...inputHashes },
        scrapedProduct: stored,
      } as unknown as ProductSourceRecord;
    };

    it('hashes the feed and the page apart on a page import, and writes both', async () => {
      const feed = feedRow();
      const result = await pageImport(feed, withPage(feed));

      expect(result.inputHashes).toEqual({
        feedIdentity: expect.any(String),
        feedSpecs: expect.any(String),
        pageIdentity: expect.any(String),
        pageSpecs: expect.any(String),
      });
      // The LLM reads the whole listing: the feed's rows and the page's.
      expect(postProcess.extractIdentity.mock.calls[0][0].rawSpecs).toEqual([...rawSpecs, ...pageRows]);
    });

    // The feed part hashes as the single hash of before, over the feed alone.
    it("gives the feed part the same hash whether or not a page is merged in", async () => {
      const feed = feedRow();
      const alone = await feedOnlyImport(feed, feed);
      const merged = await pageImport(feed, withPage(feed));

      expect(merged.inputHashes?.feedIdentity).toBe(alone.inputHashes?.feedIdentity);
    });

    it('reuses on a feed-only import when the feed is unchanged, the kept page merged in but not compared', async () => {
      const feed = feedRow();
      const ownRecord = recordOf(await pageImport(feed, withPage(feed)));
      postProcess.extractIdentity.mockClear();

      const result = await feedOnlyImport(feed, withPage(feed), ownRecord);

      expect(postProcess.extractIdentity).not.toHaveBeenCalled();
      expect(result.inputHashes).toEqual({ feedIdentity: expect.any(String), feedSpecs: expect.any(String) });
    });

    it('asks again on a feed-only import whose feed title changed, its kept page in the input', async () => {
      const feed = feedRow();
      const ownRecord = recordOf(await pageImport(feed, withPage(feed)));
      postProcess.extractIdentity.mockClear();
      const renamed = feedRow({ originalName: "KTM MACINA SCARP SX PRESTIGE Di2 M/43 '27 OLIVE" });

      const result = await feedOnlyImport(renamed, withPage(renamed), ownRecord);

      expect(postProcess.extractIdentity).toHaveBeenCalledTimes(1);
      expect(postProcess.extractIdentity.mock.calls[0][0].rawSpecs).toEqual([...rawSpecs, ...pageRows]);
      // Only the feed part is rewritten: the page's stored hash stays.
      expect(result.inputHashes).not.toHaveProperty('pageIdentity');
      expect(result.inputHashes?.feedIdentity).not.toBe(ownRecord.inputHashes.feedIdentity);
    });

    it('reuses on a page import when neither the feed nor the page changed', async () => {
      const feed = feedRow();
      const ownRecord = recordOf(await pageImport(feed, withPage(feed)));
      postProcess.extractIdentity.mockClear();

      await pageImport(feed, withPage(feed), ownRecord);

      expect(postProcess.extractIdentity).not.toHaveBeenCalled();
    });

    it('asks again on a page import whose page rows changed', async () => {
      const feed = feedRow();
      const ownRecord = recordOf(await pageImport(feed, withPage(feed)));
      postProcess.extractIdentity.mockClear();

      const result = await pageImport(feed, withPage(feed, { rawSpecs: [{ name: 'Neme:', values: ['Női'] }] }), ownRecord);

      expect(postProcess.extractIdentity).toHaveBeenCalledTimes(1);
      expect(result.inputHashes?.pageIdentity).not.toBe(ownRecord.inputHashes.pageIdentity);
    });

    // A listing's first page read: the page part was never hashed.
    it('asks again when a part it reads was never hashed', async () => {
      const feed = feedRow();
      const ownRecord = recordOf(await feedOnlyImport(feed, feed));
      postProcess.extractIdentity.mockClear();

      await pageImport(feed, withPage(feed), ownRecord);

      expect(postProcess.extractIdentity).toHaveBeenCalledTimes(1);
    });

    it('always asks under force', async () => {
      const feed = feedRow();
      const ownRecord = recordOf(await pageImport(feed, withPage(feed)));
      postProcess.extractIdentity.mockClear();

      await service.extractIdentity({
        context: { ...context({}, true), feedListing: feed },
        scrapedProduct: withPage(feed),
        ownRecord,
      });

      expect(postProcess.extractIdentity).toHaveBeenCalledTimes(1);
    });

    it('hashes a scraped listing as its page', async () => {
      const result = await service.extractIdentity({
        context: { ...context(), source: { ...context().source, type: 'scraping' } as ProductSource },
        scrapedProduct: listing(),
      });

      expect(result.inputHashes).toEqual({ pageIdentity: expect.any(String), pageSpecs: expect.any(String) });
    });

    // Records from before the hashes were kept by part carry identityInputHash
    // alone; an unchanged listing must not be asked again for it.
    describe('a record with only the hash of before', () => {
      const legacyRecord = (result: ScrapedProduct, legacy: string | undefined, page?: unknown) =>
        ({
          offerSpecsHash: result.offerSpecsHash,
          productSpecsHash: result.productSpecsHash,
          inputHashes: {},
          scrapedProduct: { ...omit(result, 'inputHashes'), identityInputHash: legacy, page },
        }) as unknown as ProductSourceRecord;

      it('reuses a feed listing without a page, its old hash read as its feed part', async () => {
        const feed = feedRow();
        const first = await feedOnlyImport(feed, feed);
        postProcess.extractIdentity.mockClear();

        await feedOnlyImport(feed, feed, legacyRecord(first, first.inputHashes?.feedIdentity));

        expect(postProcess.extractIdentity).not.toHaveBeenCalled();
      });

      it('reuses a scraped listing, its old hash read as its page part', async () => {
        const scraping = { ...context(), source: { ...context().source, type: 'scraping' } as ProductSource };
        const first = await service.extractIdentity({ context: scraping, scrapedProduct: listing() });
        postProcess.extractIdentity.mockClear();

        await service.extractIdentity({
          context: scraping,
          scrapedProduct: listing(),
          ownRecord: legacyRecord(first, first.inputHashes?.pageIdentity),
        });

        expect(postProcess.extractIdentity).not.toHaveBeenCalled();
      });

      it('asks once for a record with no hash at all', async () => {
        const feed = feedRow();
        const first = await feedOnlyImport(feed, feed);
        postProcess.extractIdentity.mockClear();

        await feedOnlyImport(feed, feed, legacyRecord(first, undefined));

        expect(postProcess.extractIdentity).toHaveBeenCalledTimes(1);
      });
    });
  });

  // Spec unification: once per product per source, as before — and, with the
  // source's rerunSpecsOnChange, again when the spec content changed.
  describe('unifyIfDue', () => {
    const product = (sources: Partial<ProductSourceRecord>[] = []) =>
      ({ id: 'model-1', sources }) as unknown as ProductModel;
    const ours = (fields: Partial<ProductSourceRecord> = {}) =>
      ({ source: { id: 'source-1' }, externalId: 'sku-43', ...fields }) as Partial<ProductSourceRecord>;
    const due = (params: {
      model?: ProductModel;
      config?: Record<string, unknown>;
      force?: boolean;
      fresh?: Record<string, string>;
      stored?: Record<string, string>;
      brandResolved?: boolean;
    }) =>
      service.unifyIfDue({
        context: context(params.config ?? {}, params.force ?? false),
        scrapedProduct: listing({ inputHashes: params.fresh ?? { feedSpecs: 'rows-1' } }),
        model: params.model,
        brandResolved: params.brandResolved ?? true,
        listingId: 'sku-43',
        storedHashes: params.stored ?? {},
      });
    const keyOf = (feedSpecs: string, pageSpecs?: string) => specsKeyOf({ feedSpecs, pageSpecs });

    describe('as before', () => {
      it('unifies a listing that creates its product, and records what from', async () => {
        const result = await due({ model: undefined });

        expect(postProcess.processModelSpecs).toHaveBeenCalledTimes(1);
        expect(metrics.specUnification).toHaveBeenCalledWith('speedbike-arukereso', 'created', 'ok');
        expect(result.inputHashes?.unifiedSpecs).toBe(keyOf('rows-1'));
      });

      it("unifies its source's first listing on an existing product", async () => {
        await due({ model: product([{ source: { id: 'other' } } as never]) });

        expect(metrics.specUnification).toHaveBeenCalledWith('speedbike-arukereso', 'new_source', 'ok');
      });

      it('unifies a listing its source already contributed when forced', async () => {
        await due({ model: product([ours()]), force: true });

        expect(metrics.specUnification).toHaveBeenCalledWith('speedbike-arukereso', 'forced', 'ok');
      });

      it('does not unify a product whose brand is unknown', async () => {
        await due({ model: undefined, brandResolved: false });

        expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
      });

      it('records nothing when unification gave nothing, for the next import to try', async () => {
        postProcess.processModelSpecs.mockResolvedValueOnce(undefined);

        const result = await due({ model: undefined });

        expect(result.inputHashes?.unifiedSpecs).toBeUndefined();
      });
    });

    describe('a listing its source already contributed', () => {
      const model = product([ours()]);

      it('does nothing when its spec content is what it was unified from', async () => {
        const result = await due({ model, stored: { unifiedSpecs: keyOf('rows-1') }, config: { postProcess: { rerunSpecsOnChange: true } } });

        expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
        expect(result.inputHashes).toEqual({ feedSpecs: 'rows-1' });
      });

      // Unified before the hashes existed: its content now is the baseline, so
      // switching the option on starts no wave.
      it('takes its content now as what it was unified from, without a call', async () => {
        const result = await due({ model, stored: {}, config: { postProcess: { rerunSpecsOnChange: true } } });

        expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
        expect(result.inputHashes?.unifiedSpecs).toBe(keyOf('rows-1'));
      });

      describe('with rerunSpecsOnChange off (the default)', () => {
        it('only counts a changed content, and keeps what it was unified from', async () => {
          const result = await due({ model, stored: { unifiedSpecs: keyOf('rows-0') } });

          expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
          expect(metrics.specUnification).toHaveBeenCalledWith('speedbike-arukereso', 'input_changed', 'would_run');
          expect(result.inputHashes?.unifiedSpecs).toBeUndefined();
        });
      });

      describe('with rerunSpecsOnChange on', () => {
        const on = { postProcess: { rerunSpecsOnChange: true } };

        it('unifies again when its spec content changed', async () => {
          const result = await due({ model, config: on, stored: { unifiedSpecs: keyOf('rows-0') } });

          expect(postProcess.processModelSpecs).toHaveBeenCalledTimes(1);
          expect(metrics.specUnification).toHaveBeenCalledWith('speedbike-arukereso', 'input_changed', 'ok');
          expect(result.specs).toMatchObject({ tubeless: true });
          expect(result.inputHashes?.unifiedSpecs).toBe(keyOf('rows-1'));
        });

        // mangobike's sizes of one model: one call, the others take its result.
        it("takes a sibling's result, unified from the same content, instead of a call", async () => {
          const sibling = ours({
            externalId: 'sku-46',
            inputHashes: { unifiedSpecs: keyOf('rows-1') },
            scrapedProduct: { specs: { tubeless: true, forkTravel: 140, weight: 99 } } as never,
          });

          const result = await due({ model: product([ours(), sibling]), config: on, stored: { unifiedSpecs: keyOf('rows-0') } });

          expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
          expect(metrics.specUnification).toHaveBeenCalledWith('speedbike-arukereso', 'input_changed', 'copied');
          // Unification's fields only: the sibling's identity values (weight) are its own.
          expect(result.specs).toEqual({ weight: 24, tubeless: true, forkTravel: 140 });
          expect(result.inputHashes?.unifiedSpecs).toBe(keyOf('rows-1'));
        });

        it('copies nothing from a sibling unified from other content', async () => {
          const sibling = ours({ externalId: 'sku-46', inputHashes: { unifiedSpecs: keyOf('rows-9') } });

          await due({ model: product([ours(), sibling]), config: on, stored: { unifiedSpecs: keyOf('rows-0') } });

          expect(postProcess.processModelSpecs).toHaveBeenCalledTimes(1);
        });

        it("copies nothing from another source's listing", async () => {
          const other = { source: { id: 'source-2' }, externalId: 'x', inputHashes: { unifiedSpecs: keyOf('rows-1') } };

          await due({ model: product([ours(), other as never]), config: on, stored: { unifiedSpecs: keyOf('rows-0') } });

          expect(postProcess.processModelSpecs).toHaveBeenCalledTimes(1);
        });

        // A feed-only import did not read the page: its stored page content counts.
        it("counts the page's stored spec content on a feed-only import", async () => {
          const unifiedFrom = keyOf('rows-1', 'page-1');

          await due({ model, config: on, fresh: { feedSpecs: 'rows-1' }, stored: { pageSpecs: 'page-1', unifiedSpecs: unifiedFrom } });

          expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
        });

        it('does nothing for a source whose unification is off', async () => {
          await due({ model, config: { postProcess: { rerunSpecsOnChange: true, specs: false } }, stored: { unifiedSpecs: keyOf('rows-0') } });

          expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
        });
      });
    });
  });
});
