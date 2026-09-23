import { AiChatRequest } from '@fittkereso-backend/ai-core';
import { OpenAiChatProvider } from './open-ai-chat.provider';
import { OpenAiClientService } from './open-ai-client.service';

describe('OpenAiChatProvider', () => {
  describe('supports()', () => {
    const provider = new OpenAiChatProvider(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    it('matches gpt- and o-series models', () => {
      expect(provider.supports('gpt-5.6-luna')).toBe(true);
      expect(provider.supports('gpt-6-luna')).toBe(true);
      expect(provider.supports('o3-mini')).toBe(true);
    });

    it('rejects models from other providers', () => {
      expect(provider.supports('deepseek-v4-flash')).toBe(false);
      expect(provider.supports('claude-haiku-4-5')).toBe(false);
    });
  });

  describe('executeChat()', () => {
    let captured: Record<string, unknown> | undefined;
    let provider: OpenAiChatProvider;

    beforeEach(() => {
      captured = undefined;
      const stubClient = {
        openAi: {
          chat: {
            completions: {
              create: async (body: Record<string, unknown>) => {
                captured = body;
                return {
                  choices: [
                    {
                      message: { role: 'assistant', content: '{}' },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                  },
                };
              },
            },
          },
        },
      };
      provider = new OpenAiChatProvider(
        {} as never,
        stubClient as unknown as OpenAiClientService,
        {} as never,
        {} as never,
      );
    });

    const baseRequest = (
      overrides: Partial<AiChatRequest> = {},
    ): AiChatRequest => ({
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'Hello there.' }],
      ...overrides,
    });

    // The reasoning-model check once matched only /^gpt-5/, so gpt-6-luna's
    // effort was silently dropped (with a warning) and every post-process
    // call ran at the API's default effort instead of the configured one.
    it.each(['gpt-5.6-luna', 'gpt-6-luna', 'o3-mini'])(
      'forwards effort as reasoning_effort on reasoning model %s',
      async (model) => {
        await provider.executeChat(baseRequest({ model, effort: 'high' }));
        expect(captured?.['reasoning_effort']).toBe('high');
      },
    );

    it('drops effort on a non-reasoning model', async () => {
      await provider.executeChat(
        baseRequest({ model: 'gpt-4o', effort: 'high' }),
      );
      expect(captured?.['reasoning_effort']).toBeUndefined();
    });

    it('never sends a thinking field', async () => {
      await provider.executeChat(baseRequest({ thinking: true, effort: 'high' }));
      expect(captured).not.toHaveProperty('thinking');
      expect(captured?.['reasoning_effort']).toBe('high');
    });

    it('requests a json_schema response_format when a schema is given', async () => {
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
      await provider.executeChat(
        baseRequest({ schema, schemaName: 'post_processed_product' }),
      );
      expect(captured?.['response_format']).toEqual({
        type: 'json_schema',
        json_schema: { name: 'post_processed_product', schema },
      });
    });
  });
});
