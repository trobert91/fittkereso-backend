export interface ChatTraceData {
  messages: Array<{
    role: string;
    content: string;
  }>;
  rawResponse: string;
  parsedResponse?: any;
  model: string;
  provider?: string;
  temperature: number;
  schema?: any;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
  };
  cost: number;
  durationMs: number;
  retryCount: number;
}
