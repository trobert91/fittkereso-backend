# ai

This library provides a provider-agnostic AI chat and embedding abstraction.

`AiChatService` routes requests to the appropriate provider (OpenAI, Gemini)
based on the model name. Providers (`AiChatProvider`, `AiEmbeddingProvider`)
self-register into `AiProviderRegistry`. Shared concerns — logging, cost
calculation, metrics, JSON-schema validation, retries, and trace collection —
live here in the orchestrator.
