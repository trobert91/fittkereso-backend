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

  it('returns the LLM-unified specs, normalized through ProductSpecNormalizationService', async () => {
    const unifiedSpecs = { weight: 21.5, frameType: 'Full-suspension' };
    aiChat.createChat.mockResolvedValueOnce({
      content: JSON.stringify({ specs: unifiedSpecs }),
      parsed: { specs: unifiedSpecs },
    });
    specNormalizer.normalize.mockReturnValueOnce({ weight: 21.5, frameType: 'Full-suspension' });

    const result = await service.process({
      data: {
        brand: 'KTM',
        model: 'Macina Scarp',
        specs: { Súly: '21,5 kg' } as any,
      },
      schema,
      goldenSample,
    });

    expect(result?.specs).toEqual({ weight: 21.5, frameType: 'Full-suspension' });
    expect(specNormalizer.normalize).toHaveBeenCalledWith(unifiedSpecs, schema);
  });

  it('sends the deterministic data as the user message and the schema/golden sample in the system prompt', async () => {
    aiChat.createChat.mockResolvedValueOnce({
      content: '{}',
      parsed: {},
    });

    await service.process({
      data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
      schema,
      goldenSample,
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
              releaseYear: undefined,
            }),
          }),
        ],
      }),
    );
  });

  it('includes the raw spec table in the user message when provided, so the LLM can infer fields from free-text rows', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

    await service.process({
      data: { brand: 'KTM', model: 'Macina Scarp', specs: { weight: 22 } },
      rawSpecs: [
        { name: 'Motor', description: 'Bosch PERFORMANCE SX BDU3144' },
        { name: 'Váz', sectionTitle: 'Alváz', values: ['Macina Scarp Prem'] },
      ],
      schema,
      goldenSample,
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
              releaseYear: undefined,
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

  it('constrains enum-like fields (meta.options) to an exact JSON Schema enum and lists them in the system prompt', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });
    const enumSchema: SpecDefinitionJsonSchema = {
      type: 'object',
      title: 'E-bike',
      properties: {
        drivetrain: {
          type: 'string',
          title: 'Drivetrain',
          meta: { options: ['Lánc', 'Szíj'] },
        },
      },
    };

    await service.process({
      data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
      schema: enumSchema,
      goldenSample: { drivetrain: 'Lánc' },
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

  it('includes brand and releaseYear as optional properties in the response schema, with no required array', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

    await service.process({
      data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
      schema,
      goldenSample,
    });

    expect(aiChat.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: expect.objectContaining({
          properties: expect.objectContaining({
            brand: { type: 'string' },
            model: { type: 'string' },
            releaseYear: { type: 'number' },
          }),
        }),
      }),
    );

    const callArgs = aiChat.createChat.mock.calls[0][0];
    expect(callArgs.schema.required).toBeUndefined();
    expect(callArgs.schema.properties.specs.required).toBeUndefined();
  });

  it('defaults to deepseek-v4-flash when no model override is given', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

    await service.process({
      data: { brand: 'KTM', model: 'Macina Scarp', specs: {} },
      schema,
      goldenSample,
    });

    expect(aiChat.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-v4-flash' }),
    );
  });

  it('returns undefined when the LLM call throws', async () => {
    aiChat.createChat.mockRejectedValueOnce(new Error('provider error'));

    const result = await service.process({
      data: {
        brand: 'KTM',
        model: 'KTM MACINA SCARP SX PRESTIGE Di2 M/43 electric bike',
        specs: { weight: 22 },
      },
      schema,
      goldenSample,
    });

    expect(result).toBeUndefined();
    expect(specNormalizer.normalize).not.toHaveBeenCalled();
  });

  it('returns undefined when the response has no parsed output', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: 'not json', parsed: undefined });

    const result = await service.process({
      data: { brand: 'brand', model: 'raw title', specs: { weight: 22 } },
      schema,
      goldenSample,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when parsed output contributes nothing on any field', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

    const result = await service.process({
      data: { brand: 'brand', model: 'raw title', specs: { weight: 22 } },
      schema,
      goldenSample,
    });

    expect(result).toBeUndefined();
  });

  it('trims a whitespace-only LLM model to undefined rather than passing it through', async () => {
    aiChat.createChat.mockResolvedValueOnce({
      content: JSON.stringify({ model: '   ' }),
      parsed: { model: '   ' },
    });

    const result = await service.process({
      data: { brand: 'KTM', model: 'raw title', specs: {} },
      schema,
      goldenSample,
    });

    // Model alone resolving to nothing means the whole contribution is empty.
    expect(result).toBeUndefined();
  });

  it('trims a whitespace-only LLM brand to undefined rather than passing it through', async () => {
    aiChat.createChat.mockResolvedValueOnce({
      content: JSON.stringify({ brand: '  ', model: 'Macina Scarp' }),
      parsed: { brand: '  ', model: 'Macina Scarp' },
    });

    const result = await service.process({
      data: { brand: 'KTM', model: 'raw title', specs: {} },
      schema,
      goldenSample,
    });

    expect(result?.brand).toBeUndefined();
    expect(result?.model).toBe('Macina Scarp');
  });

  it('passes a plain-undefined LLM releaseYear through untouched', async () => {
    aiChat.createChat.mockResolvedValueOnce({
      content: JSON.stringify({ model: 'Macina Scarp' }),
      parsed: { model: 'Macina Scarp' },
    });

    const result = await service.process({
      data: { brand: 'KTM', model: 'raw title', specs: {}, releaseYear: 2024 },
      schema,
      goldenSample,
    });

    expect(result?.releaseYear).toBeUndefined();
    expect(result?.model).toBe('Macina Scarp');
  });

  it('cleans the raw model via the LLM, stripping brand/boilerplate', async () => {
    const cleanedModel = 'MACINA SCARP SX PRESTIGE Di2';
    aiChat.createChat.mockResolvedValueOnce({
      content: JSON.stringify({ specs: {}, model: cleanedModel }),
      parsed: { specs: {}, model: cleanedModel },
    });

    const result = await service.process({
      data: {
        brand: 'KTM',
        model:
          'KTM MACINA SCARP SX PRESTIGE Di2  M/43 Összteleszkópos elektromos  MTB kerékpár OLIVE PEARL színben',
        specs: {},
      },
      schema,
      goldenSample,
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

  it('returns a corrected brand when the LLM confidently provides one', async () => {
    aiChat.createChat.mockResolvedValueOnce({
      content: JSON.stringify({ brand: 'KTM' }),
      parsed: { brand: 'KTM' },
    });

    const result = await service.process({
      data: { brand: 'ktm', model: 'Macina Scarp', specs: {} },
      schema,
      goldenSample,
    });

    expect(result?.brand).toBe('KTM');
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

      await service.process({
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

      await service.process({
        data: { brand: 'KTM', model: 'raw title', specs: {} },
        schema: schemaWithFrameSize,
        goldenSample,
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

      const result = await service.process({
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
