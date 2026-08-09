# ai-core

Shared interfaces and the singleton `AiProviderRegistry` that decouples
provider modules (`libs/openai`, `libs/gemini`) from the orchestrator
(`libs/ai`). Both depend on `ai-core` so no import cycles form.
