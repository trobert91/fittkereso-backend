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
      extractedSpecs: { Súly: '21,5 kg' } as any,
      schema,
      goldenSample,
    });

    expect(result.specs).toEqual({ weight: 21.5, frameType: 'Full-suspension' });
    expect(specNormalizer.normalize).toHaveBeenCalledWith(unifiedSpecs, schema);
  });

  it('sends the deterministic extracted specs as the user message and the schema/golden sample in the system prompt', async () => {
    aiChat.createChat.mockResolvedValueOnce({
      content: '{}',
      parsed: {},
    });

    await service.process({
      extractedSpecs: { weight: 22 },
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
            content: JSON.stringify({ deterministicSpecs: { weight: 22 } }),
          }),
        ],
      }),
    );
  });

  it('includes the raw spec table in the user message when provided, so the LLM can infer fields from free-text rows', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

    await service.process({
      extractedSpecs: { weight: 22 },
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
      extractedSpecs: {},
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

  it('defaults to deepseek-v4-flash when no model override is given', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

    await service.process({ extractedSpecs: {}, schema, goldenSample });

    expect(aiChat.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-v4-flash' }),
    );
  });

  it('falls back to the deterministic specs and raw model when the LLM call throws', async () => {
    aiChat.createChat.mockRejectedValueOnce(new Error('provider error'));
    const extractedSpecs = { weight: 22 };

    const result = await service.process({
      extractedSpecs,
      rawModel: 'KTM MACINA SCARP SX PRESTIGE Di2 M/43 electric bike',
      brand: 'KTM',
      schema,
      goldenSample,
    });

    expect(result.specs).toBe(extractedSpecs);
    expect(result.model).toBe('KTM MACINA SCARP SX PRESTIGE Di2 M/43 electric bike');
    expect(specNormalizer.normalize).not.toHaveBeenCalled();
  });

  it('falls back to the deterministic specs and raw model when the response has no parsed output', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: 'not json', parsed: undefined });
    const extractedSpecs = { weight: 22 };

    const result = await service.process({
      extractedSpecs,
      rawModel: 'raw title',
      schema,
      goldenSample,
    });

    expect(result.specs).toBe(extractedSpecs);
    expect(result.model).toBe('raw title');
  });

  it('cleans the raw model via the LLM when rawModel is provided, stripping brand/boilerplate', async () => {
    const cleanedModel = 'MACINA SCARP SX PRESTIGE Di2';
    aiChat.createChat.mockResolvedValueOnce({
      content: JSON.stringify({ specs: {}, model: cleanedModel }),
      parsed: { specs: {}, model: cleanedModel },
    });

    const result = await service.process({
      extractedSpecs: {},
      rawModel:
        'KTM MACINA SCARP SX PRESTIGE Di2  M/43 Összteleszkópos elektromos  MTB kerékpár OLIVE PEARL színben',
      brand: 'KTM',
      schema,
      goldenSample,
    });

    expect(result.model).toBe(cleanedModel);
    expect(aiChat.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('rawModel'),
          }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('"rawModel"'),
          }),
        ],
      }),
    );
  });

  it('keeps the raw model unchanged when rawModel is not provided (no model cleanup requested)', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

    const result = await service.process({ extractedSpecs: {}, schema, goldenSample });

    expect(result.model).toBeUndefined();
    expect(aiChat.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.not.stringContaining('rawModel'),
          }),
          expect.anything(),
        ],
      }),
    );
  });
});
