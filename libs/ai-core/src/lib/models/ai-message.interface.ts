// Mirrors OpenAI's chat message shape so multimodal callers (e.g. image_analyzer)
// can pass through richer content arrays unchanged.
export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  role: AiMessageRole;
  content: string | unknown[];
}
