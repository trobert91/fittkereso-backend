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
