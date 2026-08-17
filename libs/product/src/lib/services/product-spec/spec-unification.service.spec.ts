import { SpecUnificationService } from './spec-unification.service';
import type { SpecDefinitionJsonSchema } from '@fittkereso-backend/database';

describe('SpecUnificationService', () => {
  let service: SpecUnificationService;
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
    service = new SpecUnificationService(aiChat as any, specNormalizer as any);
  });

  it('returns the LLM-unified specs, normalized through ProductSpecNormalizationService', async () => {
    const unified = { weight: 21.5, frameType: 'Full-suspension' };
    aiChat.createChat.mockResolvedValueOnce({
      content: JSON.stringify(unified),
      parsed: unified,
    });
    specNormalizer.normalize.mockReturnValueOnce({ weight: 21.5, frameType: 'Full-suspension' });

    const result = await service.unify({
      extractedSpecs: { Súly: '21,5 kg' } as any,
      schema,
      goldenSample,
    });

    expect(result).toEqual({ weight: 21.5, frameType: 'Full-suspension' });
    expect(specNormalizer.normalize).toHaveBeenCalledWith(unified, schema);
  });

  it('sends the deterministic extracted specs as the user message and the schema/golden sample in the system prompt', async () => {
    aiChat.createChat.mockResolvedValueOnce({
      content: '{}',
      parsed: {},
    });

    await service.unify({
      extractedSpecs: { weight: 22 },
      schema,
      goldenSample,
      model: 'custom-model',
    });

    expect(aiChat.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        costLabel: 'spec-unification',
        schemaName: 'unified_specs',
        model: 'custom-model',
        messages: [
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Full-suspension'),
          }),
          expect.objectContaining({
            role: 'user',
            content: JSON.stringify({ weight: 22 }),
          }),
        ],
      }),
    );
  });

  it('defaults to deepseek-v4-flash when no model override is given', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: '{}', parsed: {} });

    await service.unify({ extractedSpecs: {}, schema, goldenSample });

    expect(aiChat.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-v4-flash' }),
    );
  });

  it('falls back to the deterministic specs when the LLM call throws', async () => {
    aiChat.createChat.mockRejectedValueOnce(new Error('provider error'));
    const extractedSpecs = { weight: 22 };

    const result = await service.unify({ extractedSpecs, schema, goldenSample });

    expect(result).toBe(extractedSpecs);
    expect(specNormalizer.normalize).not.toHaveBeenCalled();
  });

  it('falls back to the deterministic specs when the response has no parsed output', async () => {
    aiChat.createChat.mockResolvedValueOnce({ content: 'not json', parsed: undefined });
    const extractedSpecs = { weight: 22 };

    const result = await service.unify({ extractedSpecs, schema, goldenSample });

    expect(result).toBe(extractedSpecs);
  });
});
