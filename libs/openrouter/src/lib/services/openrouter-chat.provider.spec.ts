import { OpenRouterChatProvider } from './openrouter-chat.provider';

describe('OpenRouterChatProvider', () => {
  const provider = new OpenRouterChatProvider(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  describe('supports()', () => {
    it('matches the openrouter: prefix', () => {
      expect(provider.supports('openrouter:deepseek/deepseek-chat-v4')).toBe(true);
      expect(provider.supports('openrouter:openai/gpt-5.4-mini')).toBe(true);
    });

    it('rejects models from other providers', () => {
      expect(provider.supports('gpt-5-mini')).toBe(false);
      expect(provider.supports('gemini-3-flash')).toBe(false);
      expect(provider.supports('claude-haiku-4-5')).toBe(false);
      expect(provider.supports('deepseek/deepseek-chat-v4')).toBe(false);
    });
  });
});
