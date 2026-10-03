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
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['drivetrain'],
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
        outputKeys: ['weight', 'frameType'],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(callArgs.schema.properties.brand).toBeUndefined();
      expect(callArgs.schema.properties.model).toBeUndefined();
      expect(callArgs.schema.required).toBeUndefined();
      expect(callArgs.schema.properties.specs.required).toBeUndefined();
    });

    // The identity extraction settled these already; unification may neither
    // re-derive nor overwrite them.
    it('fills only its own fields, never an identity field', async () => {
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
        outputKeys: ['weight'],
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
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['weight', 'frameType'],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).not.toMatch(/strip the brand/);
      expect(systemPrompt).toContain('Never return "brand"/"model"');
    });

    it('includes the identity extraction\'s values as read-only context in the user message', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        knownSpecs: { frameSize: 43, modelYear: 2026 },
        schema,
        goldenSample,
        outputKeys: ['weight', 'frameType'],
      });

      const userMessage = JSON.parse(aiChat.createChat.mock.calls[0][0].messages[1].content);
      expect(userMessage.knownSpecs).toEqual({ frameSize: 43, modelYear: 2026 });
    });

    it('omits knownSpecs from the user message when there are none', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        schema,
        goldenSample,
        outputKeys: ['weight', 'frameType'],
      });

      const userMessage = JSON.parse(aiChat.createChat.mock.calls[0][0].messages[1].content);
      expect(userMessage.knownSpecs).toBeUndefined();
    });

    // The one golden sample holds every field; unification is shown only the
    // fields it fills, so an identity value never appears as an example.
    it('shows only its own fields of the golden sample', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        outputKeys: ['weight'],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).toContain('{"weight":22}');
      expect(systemPrompt).not.toContain('Full-suspension');
    });

    it('leaves the worked example out entirely without a golden sample', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).not.toContain('Worked example');
      expect(systemPrompt).not.toContain('golden example');
    });

    it('defaults to gpt-6-luna when no model override is given', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        outputKeys: ['weight', 'frameType'],
      });

      expect(aiChat.createChat).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-6-luna' }),
      );
    });

    it('tells the LLM that component-implied categorical values count as evidence, but never numbers from its own knowledge', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        outputKeys: ['weight', 'frameType'],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).toContain(
        'A categorical or yes/no value that follows directly from a named component or a stated limit counts as clearly present',
      );
      expect(systemPrompt).toContain(
        'never fill a numeric field (power, torque, capacity, travel, weight, etc.) from your own knowledge of a component',
      );
    });

    it('defaults to high effort, without asserting thinking or maxTokens explicitly', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        goldenSample,
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['weight', 'frameType'],
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
        outputKeys: ['weight', 'frameType'],
      });

      expect(result).toBeUndefined();
    });

    it('returns undefined when parsed output has no specs', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      const result = await service.processModelSpecs({
        data: { brand: 'brand', model: 'raw title', specs: { weight: 22 } },
        schema,
        goldenSample,
        outputKeys: ['weight', 'frameType'],
      });

      expect(result).toBeUndefined();
    });

    it('independent failure does not affect a concurrent identity extraction', async () => {
      aiChat.createChat.mockRejectedValueOnce(new Error('model-spec call failed'));

      const modelSpecsResult = await service.processModelSpecs({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
        schema,
        goldenSample,
        outputKeys: ['weight', 'frameType'],
      });
      expect(modelSpecsResult).toBeUndefined();

      aiChat.createChat.mockResolvedValueOnce({
        content: JSON.stringify({ brand: 'KTM' }),
        parsed: { brand: 'KTM' },
      });
      const identityResult = await service.extractIdentity({
        data: { brand: 'ktm', model: 'Macina Scarp', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
        offerLevelSpecs: [],
      });
      expect(identityResult?.brand).toBe('KTM');
    });
  });

  describe('extractIdentity', () => {
    it('defaults to high effort, without asserting thinking or maxTokens explicitly', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.extractIdentity({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
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

      const result = await service.extractIdentity({
        data: { brand: 'ktm', model: 'Macina Scarp', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
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

      const result = await service.extractIdentity({
        data: {
          brand: 'KTM',
          model:
            'KTM MACINA SCARP SX PRESTIGE Di2  M/43 Összteleszkópos elektromos  MTB kerékpár OLIVE PEARL színben',
          specs: {},
        },
        schema,
        outputKeys: ['weight', 'frameType'],
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

      await service.extractIdentity({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        description: 'Stabil karbonvázával és kiváló minőségű komponenseivel.',
        schema,
        outputKeys: ['weight', 'frameType'],
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

      await service.extractIdentity({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
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

      const result = await service.extractIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
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

      const result = await service.extractIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
        offerLevelSpecs: [],
      });

      expect(result?.brand).toBeUndefined();
      expect(result?.model).toBe('Macina Scarp');
    });

    it('returns undefined when parsed output contributes nothing on any field', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      const result = await service.extractIdentity({
        data: { brand: 'brand', model: 'raw title', specs: { weight: 22 } },
        schema,
        outputKeys: ['weight', 'frameType'],
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

      const result = await service.extractIdentity({
        data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
    });

    it('returns undefined when the LLM call throws', async () => {
      aiChat.createChat.mockRejectedValueOnce(new Error('provider error'));

      const result = await service.extractIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
        offerLevelSpecs: [],
      });

      expect(result).toBeUndefined();
    });

    // The old offer-identity call dropped this contract: with one or two
    // fields to output it only added reasoning (2026-08-29). With the whole
    // identity set it keeps responses short, and it is what the 2026-09-23
    // cost measurement ran with.
    it('keeps responses diff-only: deterministic values are merged in, not echoed', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.extractIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
        offerLevelSpecs: [],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).toContain('deterministicSpecs is merged in automatically after your response');
    });

    it('tells the LLM to fill an explicit-only field only from a stated value, naming it by title', async () => {
      aiChat.createChat.mockResolvedValue({ content: '{}', parsed: {} });
      const schemaWithRider: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'E-bike',
        properties: {
          weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
          gender: { type: 'string', title: 'Target rider', meta: { explicitOnly: true } },
        },
      };
      const extract = (outputKeys: string[]) =>
        service.extractIdentity({
          data: { brand: 'KTM', model: 'raw title', specs: {} },
          schema: schemaWithRider,
          outputKeys,
          offerLevelSpecs: [],
        });

      await extract(['weight', 'gender']);
      await extract(['weight']);

      const [withField, withoutField] = aiChat.createChat.mock.calls.map(
        (call) => call[0].messages[0].content as string,
      );
      expect(withField).toContain(
        '- Fill Target rider only when the input states the value itself in words',
      );
      expect(withoutField).not.toContain('only when the input states the value itself');
    });

    it('puts exactly its output keys in the response schema, beside brand and model', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });
      const schemaWithFrameSize: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'E-bike',
        properties: {
          weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
          frameSize: { type: 'number', title: 'Frame size', meta: { unit: 'cm' } },
        },
      };

      await service.extractIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema: schemaWithFrameSize,
        outputKeys: ['frameSize'],
        offerLevelSpecs: ['frameSize'],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(callArgs.schema.properties.specs.properties.weight).toBeUndefined();
      expect(callArgs.schema.properties.specs.properties.frameSize).toBeDefined();
      expect(callArgs.schema.properties.brand).toBeDefined();
      expect(callArgs.schema.properties.model).toBeDefined();
    });

    // Measured on 20 listings: a golden sample changed 1% of values and made
    // frameSize worse. The schema's allowed values, units and examples guide
    // this call alone.
    it('is guided by the schema alone: no golden sample, no worked example', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.extractIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema,
        outputKeys: ['weight', 'frameType'],
        offerLevelSpecs: [],
      });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).not.toContain('Worked example');
      expect(systemPrompt).not.toContain('Full-suspension');
      expect(systemPrompt).toContain('- weight (number, unit: kg): Weight');
      expect(systemPrompt).toContain('Aim to fill every canonical field above');
    });

    it('sends the selected spec rows with the title and the deterministic values', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

      await service.extractIdentity({
        data: { brand: 'KTM', model: 'raw title', specs: { weight: 22 } },
        rawSpecs: [{ name: 'Motor', values: ['Bosch Performance CX'] }],
        schema,
        outputKeys: ['weight', 'frameType'],
        offerLevelSpecs: [],
      });

      expect(JSON.parse(aiChat.createChat.mock.calls[0][0].messages[1].content)).toEqual({
        deterministicSpecs: { weight: 22 },
        rawModel: 'raw title',
        brand: 'KTM',
        rawSpecs: [{ name: 'Motor', values: ['Bosch Performance CX'] }],
      });
    });

    describe('variant names', () => {
      const schemaWithVariants: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'Phone',
        properties: {
          storage: { type: 'number', title: 'Storage', meta: { unit: 'GB' } },
          finish: { type: 'string', title: 'Finish' },
          sizeLabel: { type: 'string', title: 'Size label', enum: ['S', 'M', 'L'] },
          weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
        },
      };

      it("keeps the category's free-text offer-level values as the source writes them", async () => {
        aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

        await service.extractIdentity({
          data: { brand: 'Acme', model: 'raw title', specs: {} },
          schema: schemaWithVariants,
          outputKeys: ['storage', 'finish', 'sizeLabel', 'weight'],
          offerLevelSpecs: ['storage', 'finish', 'sizeLabel'],
        });

        const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
        expect(systemPrompt).toContain('Values of Finish are the exception');
        expect(systemPrompt).toContain('Copy a value of Finish exactly as the source writes it');
        // A number is parsed, and a fixed-list value is mapped onto the list.
        expect(systemPrompt).not.toMatch(/(Values|value) of [^.]*(Storage|Size label)/);
      });

      it('names none when no offer-level field is free text', async () => {
        aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

        await service.extractIdentity({
          data: { brand: 'Acme', model: 'raw title', specs: {} },
          schema: schemaWithVariants,
          outputKeys: ['storage', 'finish', 'sizeLabel', 'weight'],
          offerLevelSpecs: ['storage', 'sizeLabel'],
        });

        const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
        expect(systemPrompt).not.toContain('are the exception');
        expect(systemPrompt).not.toContain('Copy a value of');
      });
    });

    describe('the model year', () => {
      const schemaWithYear: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'E-bike',
        properties: {
          modelYear: { type: 'number', title: 'Model year' },
          weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
        },
      };

      it('is read from an explicit field first, then from the title\'s short forms', async () => {
        aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

        await service.extractIdentity({
          data: { brand: 'KTM', model: "MACINA TEAM 892 43cm '25", specs: {} },
          schema: schemaWithYear,
          outputKeys: ['modelYear', 'weight'],
          offerLevelSpecs: [],
        });

        const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
        expect(systemPrompt).toContain(`"'26", "MY26", "2026" all mean 2026`);
        expect(systemPrompt).toContain('the explicit field wins');
        expect(systemPrompt).toContain('Never assume a year the input does not state');
      });

      it('gets no rule when the category has no year field', async () => {
        aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

        await service.extractIdentity({
          data: { brand: 'KTM', model: 'raw title', specs: {} },
          schema: schemaWithYear,
          outputKeys: ['weight'],
          offerLevelSpecs: [],
        });

        const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
        expect(systemPrompt).not.toContain('modelYear');
      });

      it('returns the year it extracted with the cleaned model', async () => {
        aiChat.createChat.mockResolvedValueOnce({
          content: '{}',
          parsed: { model: 'Macina Team 892', specs: { modelYear: 2025 } },
        });

        const result = await service.extractIdentity({
          data: { brand: 'KTM', model: "MACINA TEAM 892 43cm '25", specs: {} },
          schema: schemaWithYear,
          outputKeys: ['modelYear', 'weight'],
          offerLevelSpecs: [],
        });

        expect(result).toEqual({
          brand: undefined,
          model: 'Macina Team 892',
          specs: { modelYear: 2025 },
        });
      });
    });

    // Every key list comes from the caller (the category config), so a
    // category with entirely different fields works unchanged.
    it('follows the given keys, with nothing e-bike-specific in a stub category', async () => {
      aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });
      const monitors: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'Monitor',
        properties: {
          screenSize: { type: 'number', title: 'Screen size', meta: { unit: 'inch' } },
          resolution: { type: 'string', title: 'Resolution', enum: ['FHD', '4K'] },
          stand: { type: 'string', title: 'Stand' },
        },
      };

      await service.extractIdentity({
        data: { brand: 'LG', model: '27UL500-W 27" 4K', specs: {} },
        schema: monitors,
        outputKeys: ['screenSize', 'resolution'],
        offerLevelSpecs: [],
      });

      const callArgs = aiChat.createChat.mock.calls[0][0];
      expect(Object.keys(callArgs.schema.properties.specs.properties)).toEqual([
        'screenSize',
        'resolution',
      ]);
      const systemPrompt = callArgs.messages[0].content;
      expect(systemPrompt).toContain('- resolution (string, allowed values (pick exactly one of these, verbatim): FHD | 4K): Resolution');
      expect(systemPrompt).not.toContain('stand');
      expect(systemPrompt).not.toMatch(/modelYear|frameSize|Pay particular attention/);
    });

    describe('matcherModel', () => {
      const schemaWithKeys: SpecDefinitionJsonSchema = {
        type: 'object',
        title: 'E-bike',
        properties: {
          weight: { type: 'number', title: 'Weight', meta: { unit: 'kg' } },
          frameSize: { type: 'number', title: 'Frame size', meta: { unit: 'cm' } },
          modelYear: { type: 'number', title: 'Model year' },
        },
      };
      const rawTitle = 'KTM MACINA STYLE 810 Di2 Unisex 2026 46cm Olive Pearl';
      const extract = (matcherModel?: string, withRequest = true) => {
        aiChat.createChat.mockResolvedValueOnce({
          content: '{}',
          parsed: { model: 'Macina Style 810 Di2', ...(matcherModel ? { matcherModel } : {}) },
        });
        return service.extractIdentity({
          data: { brand: 'KTM', model: rawTitle, specs: {} },
          schema: schemaWithKeys,
          outputKeys: ['weight', 'frameSize', 'modelYear'],
          offerLevelSpecs: ['frameSize'],
          ...(withRequest
            ? {
                matcherModel: {
                  excludedKeys: ['frameSize', 'modelYear'],
                  examples: [
                    { title: 'Cube Reaction Hybrid Pro 750 27.5" M', matcherModel: 'Reaction Hybrid Pro 750' },
                  ],
                },
              }
            : {}),
        });
      };
      const systemPrompt = () => aiChat.createChat.mock.calls[0][0].messages[0].content as string;

      it('asks for it with the left-out fields by title and the category examples', async () => {
        await extract('Macina Style 810 Di2');

        expect(systemPrompt()).toContain('"matcherModel"');
        expect(systemPrompt()).toContain('a value of Frame size, Model year');
        expect(systemPrompt()).toContain('"Cube Reaction Hybrid Pro 750 27.5" M" → "Reaction Hybrid Pro 750"');
        expect(aiChat.createChat.mock.calls[0][0].schema.properties.matcherModel).toEqual({ type: 'string' });
      });

      it('returns the words the title has', async () => {
        expect((await extract('Macina Style 810 Di2'))?.matcherModel).toBe('Macina Style 810 Di2');
      });

      // A word the shop never printed can't be agreed on by two shops.
      it('drops a word the title does not have, comparing words the way the key does', async () => {
        const result = await extract('macina STYLE 810-Di2 Electric');

        expect(result?.matcherModel).toBe('macina STYLE 810-Di2');
      });

      it('is undefined when no word of it is in the title', async () => {
        expect((await extract('Elektromos kerékpár'))?.matcherModel).toBeUndefined();
      });

      // One list teaches both names which words of a title are the name.
      it('points the "model" rule at its examples', async () => {
        await extract('Macina Style 810 Di2');

        expect(systemPrompt()).toContain(
          'The matcherModel examples below show which words of a title are the name.',
        );
      });

      it('neither asks nor returns one without a request', async () => {
        const result = await extract('Macina Style 810 Di2', false);

        expect(systemPrompt()).not.toContain('matcherModel');
        expect(aiChat.createChat.mock.calls[0][0].schema.properties.matcherModel).toBeUndefined();
        expect(result?.matcherModel).toBeUndefined();
      });
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

        await service.extractIdentity({
          data: { brand: 'KTM', model: 'raw title', specs: {} },
          schema: schemaWithFrameSize,
          outputKeys: ['weight', 'frameSize', 'color'],
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
          /into "specs" when "specs" does not already have it, BEFORE removing it from "model"/,
        );
      });

      // #9, issue 4: "Macina Style XL" lost its "XL" to the size field.
      it('keeps a word of the model\'s own name in "model", and says how a listing\'s own size is written', async () => {
        aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

        await service.extractIdentity({
          data: { brand: 'KTM', model: 'raw title', specs: {} },
          schema: schemaWithFrameSize,
          outputKeys: ['weight', 'frameSize', 'color'],
          offerLevelSpecs: ['frameSize', 'color'],
        });

        const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
        expect(systemPrompt).toContain(
          'moving a value into "specs" never removes a word of the name from "model"',
        );
        expect(systemPrompt).toContain('A word of the model\'s own name is never one of them');
        expect(systemPrompt).toContain('written together with its number (e.g. "XL/53")');
        expect(systemPrompt).toContain('A listing has one size');
        expect(systemPrompt).toContain(
          'must be extracted from there if present — but never from a word of the model\'s own name',
        );
      });

      it('omits the offer-level hint entirely when no offerLevelSpecs are configured for the category', async () => {
        aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

        await service.extractIdentity({
          data: { brand: 'KTM', model: 'raw title', specs: {} },
          schema: schemaWithFrameSize,
          outputKeys: ['weight', 'frameSize', 'color'],
          offerLevelSpecs: [],
        });

        const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
        expect(systemPrompt).not.toContain('Pay particular attention to');
        expect(systemPrompt).not.toContain('A listing has one size');
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

        const result = await service.extractIdentity({
          data: {
            brand: 'KTM',
            model:
              'KTM MACINA SCARP SX PRESTIGE Di2 M/43 Összteleszkópos elektromos MTB kerékpár OLIVE PEARL színben',
            specs: {},
          },
          schema: schemaWithFrameSize,
          outputKeys: ['weight', 'frameSize', 'color'],
          offerLevelSpecs: ['frameSize', 'color'],
        });

        expect(result?.model).toBe(cleanedModel);
        expect(result?.specs).toEqual({ frameSize: 43 });
      });
    });
  });
});
