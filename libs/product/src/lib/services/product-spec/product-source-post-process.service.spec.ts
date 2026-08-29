import { ProductSourcePostProcessService } from './product-source-post-process.service';
import type { SpecDefinitionJsonSchema } from '@fittkereso-backend/database';

describe('ProductSourcePostProcessService', () => {
  let service: ProductSourcePostProcessService;
  let aiChat: { createChat: jest.Mock };
  let specNormalizer: { normalize: jest.Mock };

  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {
      weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
      frameType: { type: 'string', title: 'Frame type' },
    },
  };

  const goldenSample = { weight: 22, frameType: 'Full-suspension' };

  beforeEach(() => {
    aiChat = { createChat: jest.fn() };
    specNormalizer = {
      normalize: jest.fn((specs) => specs),
    };
    service = new ProductSourcePostProcessService(
      aiChat as any,
      specNormalizer as any,
    );
  });

  describe('processModelSpecs', () => {
    it('returns the LLM-unified specs, normalized through ProductSpecNormalizationService', async () => {
      const unifiedSpecs = { weight: 21.5, frameType: 'Full-suspension' };
      aiChat.createChat.mockResolvedValueOnce({
        content: JSON.stringify({ specs: unifiedSpecs }),
        parsed: { specs: unifiedSpecs },
      });
      specNormalizer.normalize.mockReturnValueOnce({ weight: 21.5, frameType: 'Full-suspension' });

      const result = await service.processModelSpecs({
        data: {
          brand: 'KTM',
          model: 'Macina Scarp',
          specs: { Súly: '21,5 kg' } as any,
        },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result?.specs).toEqual({ weight: 21.5, frameType: 'Full-suspension' });
      expect(specNormalizer.normalize).toHaveBeenCalledWith(unifiedSpecs, schema);
    });

    it('sends the deterministic data as the user message and the schema/golden sample in the system prompt', async () => {
      aiChat.createChat.mockResolvedValueOnce({
        content: '{}',
        parsed: {},
      });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        schema,
        goldenSample,
        offerLevelSpecs: [],
        model: 'custom-model',
      });

      expect(aiChat.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          costLabel: 'product-source-post-process',
          schemaName: 'post_processed_product',
          model: 'custom-model',
          messages: [
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('Full-suspension'),
            }),
            expect.objectContaining({
              role: 'user',
              content: JSON.stringify({
                deterministicSpecs: { weight: 22 },
                rawModel: 'Macina Scarp',
                brand: 'KTM',
              }),
            }),
          ],
        }),
      );
    });

    it('includes the raw spec table in the user message when provided, so the LLM can infer fields from free-text rows', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        rawSpecs: [
          { name: 'Motor', description: 'Bosch PERFORMANCE SX BDU3144' },
          { name: 'Váz', sectionTitle: 'Alváz', values: ['Macina Scarp Prem'] },
        ],
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(aiChat.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.anything(),
            expect.objectContaining({
              role: 'user',
              content: JSON.stringify({
                deterministicSpecs: { weight: 22 },
                rawModel: 'Macina Scarp',
                brand: 'KTM',
                rawSpecs: [
                  { name: 'Motor', description: 'Bosch PERFORMANCE SX BDU3144' },
                  { name: 'Váz', section: 'Alváz', values: ['Macina Scarp Prem'] },
                ],
              }),
            }),
          ],
        }),
      );
    });

    it('constrains fields with a schema enum to an exact JSON Schema enum and lists them in the system prompt', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });
      const enumSchema: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'E-bike',
        properties: {
          drivetrain: {
            type: 'string',
            title: 'Drivetrain',
            meta: {},
            enum: ['Lánc', 'Szíj'],
          },
        },
      };

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema: enumSchema,
        goldenSample: { drivetrain: 'Lánc' },
        offerLevelSpecs: [],
      });

      expect(aiChat.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          schema: expect.objectContaining({
            properties: expect.objectContaining({
              specs: expect.objectContaining({
                properties: expect.objectContaining({
                  drivetrain: { type: 'string', enum: ['Lánc', 'Szíj'] },
                }),
              }),
            }),
          }),
          messages: [
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('allowed values (pick exactly one of these, verbatim): Lánc | Szíj'),
            }),
            expect.anything(),
          ],
        }),
      );
    });

    it('never includes brand/model in the response schema', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(callArgs.schema.properties.brand).toBeUndefined();
      expect(callArgs.schema.properties.model).toBeUndefined();
      expect(callArgs.schema.required).toBeUndefined();
      expect(callArgs.schema.properties.specs.required).toBeUndefined();
    });

    it('excludes offer-level keys from the response schema and canonical field listing', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });
      const schemaWithFrameSize: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'E-bike',
        properties: {
          weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
          frameSize: { type: 'number', title: 'Frame size', meta: { unit: 'cm' } },
        },
      };

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema: schemaWithFrameSize,
        goldenSample,
        offerLevelSpecs: ['frameSize'],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(callArgs.schema.properties.specs.properties.frameSize).toBeUndefined();
      expect(callArgs.schema.properties.specs.properties.weight).toBeDefined();
      expect(callArgs.messages[0].content).not.toContain('Frame size');
    });

    it('instructs the LLM to omit specs that already match deterministicSpecs, to keep responses diff-only', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).toContain(
        'deterministicSpecs is already merged in automatically after your response',
      );
      expect(systemPrompt).toMatch(/omit that key entirely — do not echo it back/);
    });

    it('never mentions brand/model cleanup instructions in the system prompt', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).not.toMatch(/strip the brand/);
      expect(systemPrompt).toContain('Never return "brand"/"model"');
    });

    it('includes current offer-level values as read-only context in the user message', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        offerLevelDeterministicSpecs: { frameSize: 43 },
        schema,
        goldenSample,
        offerLevelSpecs: ['frameSize'],
      });

      const userMessage = JSON.parse(aiChat.createChat.mock.calls[0][0].messages[1].content);
      expect(userMessage.offerLevelSpecs).toEqual({ frameSize: 43 });
    });

    it('omits offerLevelSpecs from the user message when offerLevelDeterministicSpecs is empty/absent', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        schema,
        goldenSample,
        offerLevelSpecs: ['frameSize'],
      });

      const userMessage = JSON.parse(aiChat.createChat.mock.calls[0][0].messages[1].content);
      expect(userMessage.offerLevelSpecs).toBeUndefined();
    });

    it('defaults to gpt-5.6-luna when no model override is given', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(aiChat.createChat).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.6-luna' }),
      );
    });

    it('defaults to high effort, without asserting thinking or maxTokens explicitly', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.effort).toBe('high');
      expect(callArgs.maxTokens).toBeUndefined();
    });

    it('forwards per-source reasoning overrides', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
        effort: 'high',
        maxTokens: 2000,
      });

      expect(aiChat.createChat).toHaveBeenCalledWith(
        expect.objectContaining({ effort: 'high', maxTokens: 2000 }),
      );
    });

    // Supplying `effort` implies reasoning is enabled on DeepSeek, so the
    // default must not sneak back in and re-enable what the source turned off.
    it('omits effort entirely when a source disables reasoning', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
        thinking: false,
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(callArgs.thinking).toBe(false);
      expect(callArgs.effort).toBeUndefined();
    });

    it('degrades to deterministic-only when the response is truncated by the token ceiling', async () => {
      aiChat.createChat.mockResolvedValueOnce({
        content: '{"specs":{"weight":17',
        parsed: undefined,
        finishReason: 'length',
        usage: { completionTokens: 8000 },
      });

      const result = await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
    });

    it('returns undefined when the LLM call throws', async () => {
      aiChat.createChat.mockRejectedValueOnce(new Error('provider error'));

      const result = await service.processModelSpecs({
        data: {
          brand: 'KTM',
          model: 'KTM MACINA SCARP SX PRESTIGE Di2 M/43 electric bike',
          specs: { weight: 22 },
        },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
      expect(specNormalizer.normalize).not.toHaveBeenCalled();
    });

    it('returns undefined when the response has no parsed output', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: 'not json', parsed: undefined });

      const result = await service.processModelSpecs({
        data: { brand: 'brand', model: 'raw title', specs: { weight: 22 } },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
    });

    it('returns undefined when parsed output has no specs', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      const result = await service.processModelSpecs({
        data: { brand: 'brand', model: 'raw title', specs: { weight: 22 } },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
    });

    it('independent failure does not affect a hypothetical concurrent offer-identity call', async () => {
      aiChat.createChat.mockRejectedValueOnce(new Error('model-spec call failed'));

      const modelSpecsResult = await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });
      expect(modelSpecsResult).toBeUndefined();

      aiChat.createChat.mockResolvedValueOnce({
        content: JSON.stringify({ brand: 'KTM' }),
        parsed: { brand: 'KTM' },
      });
      const offerIdentityResult = await service.processOfferIdentity({
        data: { brand: 'ktm', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });
      expect(offerIdentityResult?.brand).toBe('KTM');
    });
  });

  describe('processOfferIdentity', () => {
    it('defaults to high effort, without asserting thinking or maxTokens explicitly', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.effort).toBe('high');
      expect(callArgs.maxTokens).toBeUndefined();
    });

    it('returns a corrected brand when the LLM confidently provides one', async () => {
      aiChat.createChat.mockResolvedValueOnce({
        content: JSON.stringify({ brand: 'KTM' }),
        parsed: { brand: 'KTM' },
      });

      const result = await service.processOfferIdentity({
        data: { brand: 'ktm', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result?.brand).toBe('KTM');
    });

    it('cleans the raw model via the LLM, stripping brand/boilerplate', async () => {
      const cleanedModel = 'MACINA SCARP SX PRESTIGE Di2';
      aiChat.createChat.mockResolvedValueOnce({
        content: JSON.stringify({ specs: {}, model: cleanedModel }),
        parsed: { specs: {}, model: cleanedModel },
      });

      const result = await service.processOfferIdentity({
        data: {
          brand: 'KTM',
          model:
            'KTM MACINA SCARP SX PRESTIGE Di2  M/43 Összteleszkópos elektromos  MTB kerékpár OLIVE PEARL színben',
          specs: {},
        },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result?.model).toBe(cleanedModel);
      expect(aiChat.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('"model"'),
            }),
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('"rawModel"'),
            }),
          ],
        }),
      );
    });

    it('forwards a given description into the user message and documents it as lower-confidence in the system prompt', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        description: 'Stabil karbonvázával és kiváló minőségű komponenseivel.',
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      const [systemMessage, userMessage] = callArgs.messages;
      expect(userMessage.content).toContain(
        '"description":"Stabil karbonvázával és kiváló minőségű komponenseivel."',
      );
      expect(systemMessage.content).toMatch(/description.*LOWER confidence/);
    });

    it('omits description from the user message when none is given', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      const [, userMessage] = callArgs.messages;
      expect(userMessage.content).not.toContain('"description"');
    });

    it('trims a whitespace-only LLM model to undefined rather than passing it through', async () => {
      aiChat.createChat.mockResolvedValueOnce({
        content: JSON.stringify({ model: '   ' }),
        parsed: { model: '   ' },
      });

      const result = await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      // Model alone resolving to nothing means the whole contribution is empty.
      expect(result).toBeUndefined();
    });

    it('trims a whitespace-only LLM brand to undefined rather than passing it through', async () => {
      aiChat.createChat.mockResolvedValueOnce({
        content: JSON.stringify({ brand: '  ', model: 'Macina Scarp' }),
        parsed: { brand: '  ', model: 'Macina Scarp' },
      });

      const result = await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result?.brand).toBeUndefined();
      expect(result?.model).toBe('Macina Scarp');
    });

    it('returns undefined when parsed output contributes nothing on any field', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      const result = await service.processOfferIdentity({
        data: { brand: 'brand', model: 'raw title', specs: { weight: 22 } },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
    });

    it('degrades to undefined when the response is truncated by the token ceiling', async () => {
      aiChat.createChat.mockResolvedValueOnce({
        content: '{"model":"Mac',
        parsed: undefined,
        finishReason: 'length',
        usage: { completionTokens: 8000 },
      });

      const result = await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
    });

    it('returns undefined when the LLM call throws', async () => {
      aiChat.createChat.mockRejectedValueOnce(new Error('provider error'));

      const result = await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
    });

    // Offer-identity has at most a couple of fields to output, so the
    // diff-only "only include NEW/CORRECTED fields" contract used by
    // processModelSpecs isn't applied here — it added reasoning overhead
    // with no payload-size benefit on a call this small (measured
    // 2026-08-29: completion tokens roughly tripled on real traffic with no
    // offsetting savings, since there was rarely more than one field to
    // omit in the first place).
    it('does not use the diff-only contract — keeps the original "start from deterministicSpecs" instruction', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        goldenSample,
        offerLevelSpecs: [],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).toContain(
        'Start from deterministicSpecs — those values are already correct',
      );
      expect(systemPrompt).not.toContain(
        'deterministicSpecs is already merged in automatically after your response',
      );
    });

    it('never includes non-offer-level keys in the response schema', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });
      const schemaWithFrameSize: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'E-bike',
        properties: {
          weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
          frameSize: { type: 'number', title: 'Frame size', meta: { unit: 'cm' } },
        },
      };

      await service.processOfferIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema: schemaWithFrameSize,
        goldenSample,
        offerLevelSpecs: ['frameSize'],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(callArgs.schema.properties.specs.properties.weight).toBeUndefined();
      expect(callArgs.schema.properties.specs.properties.frameSize).toBeDefined();
      expect(callArgs.schema.properties.brand).toBeDefined();
      expect(callArgs.schema.properties.model).toBeDefined();
    });

    describe('offerLevelSpecs extraction guidance', () => {
      const schemaWithFrameSize: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'E-bike',
        properties: {
          weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
          frameSize: { type: 'number', title: 'Frame size', meta: { unit: 'cm' } },
          color: { type: 'string', title: 'Color' },
        },
      };

      it('tells the LLM to extract offer-level fields from the raw title before stripping them', async () => {
        aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

        await service.processOfferIdentity({
          data: { brand: 'KTM', model: 'raw title', specs: {} },
          schema: schemaWithFrameSize,
          goldenSample,
          offerLevelSpecs: ['frameSize', 'color'],
        });

        expect(aiChat.createChat).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [
              expect.objectContaining({
                role: 'system',
                content: expect.stringContaining('Frame size, Color'),
              }),
              expect.anything(),
            ],
          }),
        );
        const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
        expect(systemPrompt).toContain('rawModel');
        expect(systemPrompt).toMatch(
          /add them to "specs".*BEFORE removing them from "model"/,
        );
      });

      it('omits the offer-level hint entirely when no offerLevelSpecs are configured for the category', async () => {
        aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

        await service.processOfferIdentity({
          data: { brand: 'KTM', model: 'raw title', specs: {} },
          schema: schemaWithFrameSize,
          goldenSample,
          offerLevelSpecs: [],
        });

        const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
        expect(systemPrompt).not.toContain('Pay particular attention to');
      });

      it('extracts a frame size embedded only in the raw title into specs, per the KTM example', async () => {
        const cleanedModel = 'MACINA SCARP SX PRESTIGE Di2';
        aiChat.createChat.mockResolvedValueOnce({
          content: JSON.stringify({
            model: cleanedModel,
            specs: { frameSize: 43 },
          }),
          parsed: { model: cleanedModel, specs: { frameSize: 43 } },
        });

        const result = await service.processOfferIdentity({
          data: {
            brand: 'KTM',
            model:
              'KTM MACINA SCARP SX PRESTIGE Di2 M/43 Összteleszkópos elektromos MTB kerékpár OLIVE PEARL színben',
            specs: {},
          },
          schema: schemaWithFrameSize,
          goldenSample,
          offerLevelSpecs: ['frameSize', 'color'],
        });

        expect(result?.model).toBe(cleanedModel);
        expect(result?.specs).toEqual({ frameSize: 43 });
      });
    });
  });
});
