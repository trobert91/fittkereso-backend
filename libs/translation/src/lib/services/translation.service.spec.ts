import { TranslationService } from './translation.service';

describe('TranslationService', () => {
  let service: TranslationService;

  // Mocks
  let dynamicConfig: { translation: any };
  let cacheRepo: {
    findBatchCacheHits: jest.Mock;
    storeBatch: jest.Mock;
  };
  let aiChat: { createChat: jest.Mock };
  let metrics: {
    recordBatch: jest.Mock;
    recordItems: jest.Mock;
    recordLlmCall: jest.Mock;
  };

  beforeEach(() => {
    dynamicConfig = {
      translation: {
        enabled: true,
        model: 'gpt-5.4-nano',
        defaultSourceLanguage: 'hu',
        defaultTargetLanguage: 'en',
        cacheTtlDays: 365,
        maxBatchSize: 50,
        dictionary: {
          hu: {
            van: 'yes',
            nincs: 'no',
            fejhallgató: 'headphones',
          },
        },
      },
    };
    cacheRepo = {
      findBatchCacheHits: jest.fn().mockResolvedValue(new Map()),
      storeBatch: jest.fn().mockResolvedValue(undefined),
    };
    aiChat = {
      createChat: jest.fn(),
    };
    metrics = {
      recordBatch: jest.fn(),
      recordItems: jest.fn(),
      recordLlmCall: jest.fn(),
    };
    service = new TranslationService(
      dynamicConfig as any,
      cacheRepo as any,
      aiChat as any,
      metrics as any,
    );
  });

  // helper for a successful LLM response
  const llmResponse = (items: Array<{ source: string; translation: string }>) => ({
    choices: [
      {
        message: {
          content: JSON.stringify({ translations: items }),
        },
      },
    ],
  });

  describe('empty/edge cases', () => {
    it('returns empty map for empty input', async () => {
      const { translations, stats } = await service.translateBatch({ texts: [] });
      expect(translations.size).toBe(0);
      expect(stats.inputCount).toBe(0);
      expect(stats.uniqueCount).toBe(0);
      expect(cacheRepo.findBatchCacheHits).not.toHaveBeenCalled();
      expect(aiChat.createChat).not.toHaveBeenCalled();
    });

    it('filters out undefined/empty entries before processing', async () => {
      const { stats } = await service.translateBatch({
        texts: [undefined, '', '   ', 'van'],
      });
      expect(stats.inputCount).toBe(4);
      expect(stats.uniqueCount).toBe(1);
      expect(stats.fromDictionary).toBe(1);
    });

    it('identity fast-path when source === target', async () => {
      const { translations, stats } = await service.translateBatch({
        texts: ['anything'],
        sourceLanguage: 'en',
        targetLanguage: 'en',
      });
      expect(translations.size).toBe(0);
      expect(stats.fromDictionary).toBe(0);
      expect(cacheRepo.findBatchCacheHits).not.toHaveBeenCalled();
      expect(aiChat.createChat).not.toHaveBeenCalled();
    });

    it('skips purely numeric strings and returns them unchanged via lookup', async () => {
      const { stats, lookup } = await service.translateBatch({
        texts: ['12000', '99', '6', '-3.14', '+42', '1,234', '12 000'],
      });
      expect(stats.inputCount).toBe(7);
      expect(stats.uniqueCount).toBe(0);
      expect(stats.fromDictionary).toBe(0);
      expect(stats.fromCache).toBe(0);
      expect(stats.fromLlm).toBe(0);
      expect(cacheRepo.findBatchCacheHits).not.toHaveBeenCalled();
      expect(cacheRepo.storeBatch).not.toHaveBeenCalled();
      expect(aiChat.createChat).not.toHaveBeenCalled();
      expect(lookup('12000')).toBe('12000');
      expect(lookup('99')).toBe('99');
      expect(lookup('-3.14')).toBe('-3.14');
    });

    it('never reads OR writes the cache for numeric-only strings, even mixed with non-numerics', async () => {
      cacheRepo.findBatchCacheHits.mockResolvedValue(new Map());
      aiChat.createChat.mockResolvedValue(
        llmResponse([{ source: 'új dolog', translation: 'new thing' }]),
      );

      await service.translateBatch({
        texts: ['12000', '99', 'új dolog', '-3.14'],
      });

      // Cache lookup should see ONLY "új dolog" — numerics are stripped.
      expect(cacheRepo.findBatchCacheHits).toHaveBeenCalledTimes(1);
      expect(cacheRepo.findBatchCacheHits).toHaveBeenCalledWith({
        sourceLanguage: 'hu',
        targetLanguage: 'en',
        sourceTexts: ['új dolog'],
      });

      // Cache write should ONLY include the non-numeric LLM-translated entry.
      expect(cacheRepo.storeBatch).toHaveBeenCalledTimes(1);
      const storeCall = cacheRepo.storeBatch.mock.calls[0][0];
      expect(storeCall.items).toEqual([
        expect.objectContaining({
          sourceText: 'új dolog',
          translatedText: 'new thing',
        }),
      ]);
      // Numeric strings must never appear as source text in any cache write
      expect(storeCall.items.every((i: any) => !/^[\d-]/.test(i.sourceText))).toBe(
        true,
      );
    });

    it('keeps non-numeric strings even when mixed with numeric ones', async () => {
      const { stats, lookup } = await service.translateBatch({
        texts: ['99', 'Van', '12000'],
      });
      expect(stats.inputCount).toBe(3);
      expect(stats.uniqueCount).toBe(1);
      expect(stats.fromDictionary).toBe(1);
      expect(lookup('99')).toBe('99');
      expect(lookup('Van')).toBe('yes');
    });

    it('does NOT skip numeric-with-unit strings (they still need unit stripping via translation)', async () => {
      cacheRepo.findBatchCacheHits.mockResolvedValue(new Map());
      aiChat.createChat.mockResolvedValue(
        llmResponse([{ source: '99 g', translation: '99 g' }]),
      );
      const { stats } = await service.translateBatch({
        texts: ['99 g'],
      });
      // "99 g" contains a non-digit letter, so it's NOT purely numeric and goes
      // through the normal pipeline. (This matters only for sources that still
      // pass unit-bearing strings; the scraper now pre-filters numeric specs.)
      expect(stats.uniqueCount).toBe(1);
    });
  });

  describe('dictionary pass', () => {
    it('resolves from dictionary without calling cache or LLM', async () => {
      const { translations, stats, lookup } = await service.translateBatch({
        texts: ['Van', 'Nincs', 'fejhallgató'],
      });
      expect(stats.fromDictionary).toBe(3);
      expect(stats.fromCache).toBe(0);
      expect(stats.fromLlm).toBe(0);
      expect(translations.get('van')).toBe('yes');
      expect(translations.get('nincs')).toBe('no');
      expect(lookup('VAN')).toBe('yes');
      expect(cacheRepo.findBatchCacheHits).not.toHaveBeenCalled();
      expect(aiChat.createChat).not.toHaveBeenCalled();
    });
  });

  describe('dedupe', () => {
    it('deduplicates duplicate case/whitespace variants', async () => {
      const { stats } = await service.translateBatch({
        texts: ['Van', 'VAN', ' van ', 'van\n'],
      });
      expect(stats.inputCount).toBe(4);
      expect(stats.uniqueCount).toBe(1);
      expect(stats.fromDictionary).toBe(1);
    });

    it('lookup() resolves raw duplicates via normalization', async () => {
      const { lookup } = await service.translateBatch({
        texts: ['Van', 'VAN'],
      });
      expect(lookup('Van')).toBe('yes');
      expect(lookup(' VAN ')).toBe('yes');
      expect(lookup('van')).toBe('yes');
    });

    it('10 identical strings → 1 cache lookup, 1 LLM item if uncached', async () => {
      aiChat.createChat.mockResolvedValue(
        llmResponse([{ source: 'valami ismeretlen', translation: 'something unknown' }]),
      );

      const dupes = Array(10).fill('Valami Ismeretlen');
      const { stats } = await service.translateBatch({ texts: dupes });

      expect(stats.inputCount).toBe(10);
      expect(stats.uniqueCount).toBe(1);
      expect(cacheRepo.findBatchCacheHits).toHaveBeenCalledTimes(1);
      expect(cacheRepo.findBatchCacheHits).toHaveBeenCalledWith({
        sourceLanguage: 'hu',
        targetLanguage: 'en',
        sourceTexts: ['valami ismeretlen'],
      });
      expect(aiChat.createChat).toHaveBeenCalledTimes(1);
      const userPayload = JSON.parse(aiChat.createChat.mock.calls[0][0].messages[1].content);
      expect(userPayload.items).toEqual(['valami ismeretlen']);
      expect(stats.fromLlm).toBe(1);
      expect(cacheRepo.storeBatch).toHaveBeenCalledTimes(1);
      expect(cacheRepo.storeBatch.mock.calls[0][0].items).toHaveLength(1);
    });
  });

  describe('cache pass', () => {
    it('resolves from cache when not in dictionary', async () => {
      cacheRepo.findBatchCacheHits.mockResolvedValue(
        new Map([['csatlakozás', 'connection']]),
      );

      const { translations, stats } = await service.translateBatch({
        texts: ['Csatlakozás'],
      });

      expect(stats.fromCache).toBe(1);
      expect(stats.fromLlm).toBe(0);
      expect(translations.get('csatlakozás')).toBe('connection');
      expect(aiChat.createChat).not.toHaveBeenCalled();
    });

    it('does not call LLM when dictionary + cache cover everything', async () => {
      cacheRepo.findBatchCacheHits.mockResolvedValue(
        new Map([['bluetooth verziószám', 'bluetooth version']]),
      );

      const { stats } = await service.translateBatch({
        texts: ['Van', 'Bluetooth verziószám'],
      });
      expect(stats.fromDictionary).toBe(1);
      expect(stats.fromCache).toBe(1);
      expect(stats.fromLlm).toBe(0);
      expect(aiChat.createChat).not.toHaveBeenCalled();
    });

    it('only sends the uncached items to the LLM', async () => {
      cacheRepo.findBatchCacheHits.mockResolvedValue(
        new Map([['cached term', 'cached translation']]),
      );
      aiChat.createChat.mockResolvedValue(
        llmResponse([{ source: 'uncached term', translation: 'uncached translation' }]),
      );

      const { stats } = await service.translateBatch({
        texts: ['Van', 'cached term', 'uncached term'],
      });

      expect(stats.fromDictionary).toBe(1);
      expect(stats.fromCache).toBe(1);
      expect(stats.fromLlm).toBe(1);
      expect(aiChat.createChat).toHaveBeenCalledTimes(1);
      const userPayload = JSON.parse(aiChat.createChat.mock.calls[0][0].messages[1].content);
      expect(userPayload.items).toEqual(['uncached term']);
    });
  });

  describe('context', () => {
    it('injects the caller-supplied context into the LLM system prompt', async () => {
      aiChat.createChat.mockResolvedValue(
        llmResponse([{ source: 'optikai', translation: 'optical' }]),
      );

      await service.translateBatch({
        texts: ['optikai'],
        context:
          'Technical specification values from an arukereso.hu product listing in the "Mice" category.',
      });

      expect(aiChat.createChat).toHaveBeenCalledTimes(1);
      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).toContain('Domain context:');
      expect(systemPrompt).toContain('"Mice" category');
      expect(systemPrompt).toContain('arukereso.hu');
    });

    it('omits the context block when no context is provided', async () => {
      aiChat.createChat.mockResolvedValue(
        llmResponse([{ source: 'valami', translation: 'something' }]),
      );

      await service.translateBatch({ texts: ['valami'] });

      const systemPrompt = aiChat.createChat.mock.calls[0][0].messages[0].content;
      expect(systemPrompt).not.toContain('Domain context:');
    });

    it('does NOT call LLM when dictionary covers everything, even with context set', async () => {
      await service.translateBatch({
        texts: ['Van'],
        context: 'some context',
      });
      // Dictionary hit — no LLM call, context is irrelevant
      expect(aiChat.createChat).not.toHaveBeenCalled();
    });
  });

  describe('llm pass', () => {
    it('stores LLM results in cache', async () => {
      aiChat.createChat.mockResolvedValue(
        llmResponse([{ source: 'új kifejezés', translation: 'new term' }]),
      );

      await service.translateBatch({ texts: ['Új kifejezés'] });

      expect(cacheRepo.storeBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceLanguage: 'hu',
          targetLanguage: 'en',
          source: 'llm',
          items: [
            expect.objectContaining({
              sourceText: 'új kifejezés',
              translatedText: 'new term',
              model: 'gpt-5.4-nano',
            }),
          ],
          ttlDays: 365,
        }),
      );
    });

    it('LLM failure falls through to untranslated', async () => {
      aiChat.createChat.mockRejectedValue(new Error('rate limited'));

      const { stats, lookup } = await service.translateBatch({
        texts: ['Új kifejezés'],
      });

      expect(stats.untranslated).toBe(1);
      expect(stats.fromLlm).toBe(0);
      expect(lookup('Új kifejezés')).toBe('Új kifejezés');
      expect(cacheRepo.storeBatch).not.toHaveBeenCalled();
    });

    it('enabled=false skips LLM and records untranslated', async () => {
      dynamicConfig.translation.enabled = false;

      const { stats } = await service.translateBatch({
        texts: ['Új kifejezés'],
      });

      expect(stats.untranslated).toBe(1);
      expect(stats.fromLlm).toBe(0);
      expect(aiChat.createChat).not.toHaveBeenCalled();
      expect(cacheRepo.storeBatch).not.toHaveBeenCalled();
    });

    it('rejects LLM entries whose source was not in the input set', async () => {
      aiChat.createChat.mockResolvedValue(
        llmResponse([
          { source: 'valami', translation: 'something' },
          { source: 'hallucinated', translation: 'evil' }, // not in input
        ]),
      );

      const { translations, stats } = await service.translateBatch({
        texts: ['Valami'],
      });

      expect(translations.get('valami')).toBe('something');
      expect(translations.has('hallucinated')).toBe(false);
      expect(stats.fromLlm).toBe(1);
    });

    it('chunks LLM calls when uncached items exceed maxBatchSize', async () => {
      dynamicConfig.translation.maxBatchSize = 2;
      const texts = ['a', 'b', 'c', 'd', 'e'];

      aiChat.createChat
        .mockResolvedValueOnce(
          llmResponse([
            { source: 'a', translation: 'A' },
            { source: 'b', translation: 'B' },
          ]),
        )
        .mockResolvedValueOnce(
          llmResponse([
            { source: 'c', translation: 'C' },
            { source: 'd', translation: 'D' },
          ]),
        )
        .mockResolvedValueOnce(
          llmResponse([{ source: 'e', translation: 'E' }]),
        );

      const { translations, stats } = await service.translateBatch({ texts });

      expect(aiChat.createChat).toHaveBeenCalledTimes(3);
      expect(stats.fromLlm).toBe(5);
      expect(translations.get('a')).toBe('A');
      expect(translations.get('e')).toBe('E');
    });

    it('recovers gracefully from invalid JSON in LLM response', async () => {
      aiChat.createChat.mockResolvedValue({
        choices: [{ message: { content: 'this is not json' } }],
      });

      const { stats } = await service.translateBatch({
        texts: ['valami'],
      });

      expect(stats.fromLlm).toBe(0);
      expect(stats.untranslated).toBe(1);
    });
  });

  describe('metrics', () => {
    it('records batch and item metrics on every call', async () => {
      await service.translateBatch({ texts: ['Van'] });
      expect(metrics.recordBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceLanguage: 'hu',
          targetLanguage: 'en',
          outcome: 'success',
        }),
      );
      expect(metrics.recordItems).toHaveBeenCalledWith(
        expect.objectContaining({
          fromDictionary: 1,
          fromCache: 0,
          fromLlm: 0,
          untranslated: 0,
        }),
      );
    });

    it('records LLM call metrics on success', async () => {
      aiChat.createChat.mockResolvedValue(
        llmResponse([{ source: 'valami', translation: 'something' }]),
      );

      await service.translateBatch({ texts: ['valami'] });

      expect(metrics.recordLlmCall).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceLanguage: 'hu',
          targetLanguage: 'en',
          status: 'success',
          chunkSize: 1,
        }),
      );
    });

    it('records LLM call metrics on error', async () => {
      aiChat.createChat.mockRejectedValue(new Error('boom'));

      await service.translateBatch({ texts: ['valami'] });

      expect(metrics.recordLlmCall).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          chunkSize: 1,
        }),
      );
    });
  });
});
