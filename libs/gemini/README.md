# gemini

Google Gemini SDK adapter. Wraps `@google/genai` and exposes
`GeminiChatProvider`, which implements the `AiChatProvider` interface from
`@fittkereso-backend/ai`. Self-registers into `AiProviderRegistry` on module
init so requests with a `gemini-*` model name route here automatically.

Schema translation from OpenAI JSON Schema dialect to Gemini's OpenAPI subset
lives in `utils/json-schema-to-gemini.ts` (strips `additionalProperties`,
unsupported keys, lowercases types).
