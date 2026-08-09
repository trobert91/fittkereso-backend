import { AiChatRequest } from "@ebike-backend/ai-core";
import { DeepSeekChatProvider } from "./deepseek-chat.provider";
import {
  DeepSeekChatRequestBody,
  DeepSeekClientService,
} from "./deepseek-client.service";

describe("DeepSeekChatProvider", () => {
  describe("supports()", () => {
    const provider = new DeepSeekChatProvider(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    it("matches the deepseek- prefix", () => {
      expect(provider.supports("deepseek-v4-flash")).toBe(true);
      expect(provider.supports("deepseek-v4-pro")).toBe(true);
      expect(provider.supports("deepseek-chat")).toBe(true);
      expect(provider.supports("deepseek-reasoner")).toBe(true);
    });

    it("rejects models from other providers", () => {
      expect(provider.supports("gpt-5-mini")).toBe(false);
      expect(provider.supports("claude-haiku-4-5")).toBe(false);
      expect(provider.supports("gemini-3-flash")).toBe(false);
      expect(provider.supports("openrouter:deepseek/deepseek-v4-flash")).toBe(
        false,
      );
    });
  });

  describe("executeChat()", () => {
    let captured: DeepSeekChatRequestBody | undefined;
    let provider: DeepSeekChatProvider;

    beforeEach(() => {
      captured = undefined;
      const stubClient: Pick<DeepSeekClientService, "createChatCompletion"> = {
        createChatCompletion: async (body) => {
          captured = body;
          return {
            choices: [
              {
                message: { role: "assistant", content: "{}" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      };
      provider = new DeepSeekChatProvider(
        {} as never,
        stubClient as DeepSeekClientService,
        {} as never,
        {} as never,
      );
    });

    const baseRequest = (
      overrides: Partial<AiChatRequest> = {},
    ): AiChatRequest => ({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "Hello there." }],
      ...overrides,
    });

    it("does not set response_format when no schema is requested", async () => {
      await provider.executeChat(baseRequest());
      expect(captured?.response_format).toBeUndefined();
      expect(captured?.messages).toHaveLength(1);
    });

    it('injects a JSON system message with schema example when schema is set and prompt lacks the word "json"', async () => {
      const schema = {
        type: "object",
        properties: { ok: { type: "boolean" } },
      };
      await provider.executeChat(baseRequest({ schema }));

      expect(captured?.response_format).toEqual({ type: "json_object" });
      expect(captured?.messages).toHaveLength(2);
      const injected = captured?.messages[0];
      expect(injected).toBeDefined();
      if (!injected) return;
      expect(injected.role).toBe("system");
      expect(injected.content).toMatch(/json/i);
      expect(injected.content).toContain(JSON.stringify(schema));
    });

    it("does not inject when the prompt already mentions JSON", async () => {
      const schema = { type: "object" };
      await provider.executeChat(
        baseRequest({
          schema,
          messages: [
            { role: "system", content: "Respond as JSON with one field." },
            { role: "user", content: "Hi." },
          ],
        }),
      );

      expect(captured?.response_format).toEqual({ type: "json_object" });
      expect(captured?.messages).toHaveLength(2);
      expect(captured?.messages[0].content).toBe(
        "Respond as JSON with one field.",
      );
    });
  });
});
