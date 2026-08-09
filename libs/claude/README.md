# claude

Anthropic Claude SDK adapter. Wraps `@anthropic-ai/sdk` and exposes
`ClaudeChatProvider`, which implements the `AiChatProvider` interface from
`@ebike-backend/ai`. Self-registers into `AiProviderRegistry` on module
init so requests with a `claude-*` model name route here automatically.

Structured output (`request.schema`) is delivered via the Anthropic tool-use
workaround: a single tool with the caller's schema as its `input_schema` and
forced `tool_choice`, then the tool input is JSON-serialized back into
`RawProviderResult.content` for the orchestrator's schema validator.
