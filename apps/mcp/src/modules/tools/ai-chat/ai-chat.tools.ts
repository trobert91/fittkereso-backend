import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { AiChatRequest, AiChatService } from "@ebike-backend/ai";

@Injectable()
export class AiChatTools {
  constructor(private readonly aiChatService: AiChatService) {}

  @Tool({
    name: "test_ai_chat",
    description:
      "Run a one-shot AI chat against the production AiChatService for prompt testing. Returns the model's response plus cost, token usage, execution time, and the chatId for follow-up log inspection. Use this when drafting or tuning a prompt to see how a specific model will behave before wiring it into the pipeline. Note: gpt-5* models do not support temperature — the tool forces temperature=1 for those models regardless of what is passed in, matching pipeline behavior.",
    parameters: z.object({
      messages: z
        .array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          }),
        )
        .min(1)
        .describe(
          "Chat messages in order. Typically starts with a system message followed by user/assistant turns.",
        ),
      model: z
        .string()
        .describe(
          'Model identifier resolved via AiProviderRegistry (e.g. "gpt-5-nano", "gpt-5-mini", Gemini models).',
        ),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe(
          "Sampling temperature. Ignored for gpt-5* models — the tool forces 1.",
        ),
      maxTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum output tokens."),
      schema: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "JSON Schema (OpenAI dialect) for structured output. When provided, the response includes a validated parsed object.",
        ),
      schemaName: z
        .string()
        .optional()
        .describe(
          "Optional name for the JSON schema (used by some providers).",
        ),
      costLabel: z
        .string()
        .optional()
        .describe(
          'Label attached to the call for cost tracking. Defaults to "mcp-test" so MCP-driven calls are distinguishable in cost analysis.',
        ),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  })
  async testAiChat(args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    model: string;
    temperature?: number;
    maxTokens?: number;
    schema?: Record<string, unknown>;
    schemaName?: string;
    costLabel?: string;
  }): Promise<string> {
    const isGpt5 = args.model.startsWith("gpt-5");
    const temperature = isGpt5 ? 1 : args.temperature;

    const request: AiChatRequest = {
      model: args.model,
      messages: args.messages,
      ...(temperature !== undefined && { temperature }),
      ...(args.maxTokens !== undefined && { maxTokens: args.maxTokens }),
      ...(args.schema !== undefined && { schema: args.schema }),
      ...(args.schemaName !== undefined && { schemaName: args.schemaName }),
      costLabel: args.costLabel ?? "mcp-test",
    };

    try {
      const response = await this.aiChatService.createChat(request);
      return this.formatResponse(response, isGpt5, args.temperature);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `# AI chat failed\n\nModel: ${args.model}\nError: ${message}`;
    }
  }

  private formatResponse(
    response: Awaited<ReturnType<AiChatService["createChat"]>>,
    gpt5TemperatureOverridden: boolean,
    userSuppliedTemperature: number | undefined,
  ): string {
    const L: string[] = [];
    L.push(`# AI Chat Response`);
    L.push(`- **chatId**: ${response.chatId}`);
    L.push(`- **provider**: ${response.provider}`);
    L.push(`- **model**: ${response.model}`);
    L.push(
      `- **executionTimeInSec**: ${response.executionTimeInSec.toFixed(3)}`,
    );
    if (response.cost !== undefined) {
      L.push(`- **cost**: $${response.cost.toFixed(6)}`);
    }
    if (response.finishReason) {
      L.push(`- **finishReason**: ${response.finishReason}`);
    }
    L.push(
      `- **usage**: prompt=${response.usage.promptTokens}, completion=${response.usage.completionTokens}, total=${response.usage.totalTokens}, cached=${response.usage.cachedTokens}`,
    );
    if (gpt5TemperatureOverridden && userSuppliedTemperature !== undefined) {
      L.push(
        `- **note**: temperature=${userSuppliedTemperature} was overridden to 1 (gpt-5* models do not accept custom temperatures).`,
      );
    }
    L.push("");

    if (response.parsed !== undefined) {
      L.push("## Parsed (schema-validated)");
      L.push("```json");
      L.push(JSON.stringify(response.parsed, null, 2));
      L.push("```");
    } else {
      L.push("## Content");
      L.push(response.content);
    }

    return L.join("\n");
  }
}
