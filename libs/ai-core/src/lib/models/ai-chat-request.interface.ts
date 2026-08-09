import { ChatTraceData } from "@ebike-backend/debug";
import { AiMessage } from "./ai-message.interface";

export interface AiChatRequest {
  model: string;
  messages: AiMessage[];

  temperature?: number;
  maxTokens?: number;

  /** Provider-agnostic reasoning toggle. true=enable, false=disable, undefined=provider default. */
  thinking?: boolean;
  /** Provider-specific reasoning-effort string, forwarded to the provider's native field as-is. */
  effort?: string;

  /** JSON Schema (OpenAI dialect). Providers translate as needed. */
  schema?: any;
  schemaName?: string;
  /** When true, schema validation failures throw (and trigger retry) instead of silently coercing. */
  strictSchema?: boolean;
  /**
   * Optional caller-supplied validator run AFTER schema validation/coercion.
   * Throw to reject the response — the chat service treats the throw as a
   * transient error and retries (subject to maxRetries), same as a provider
   * error. Return value is ignored. Use for semantic checks the JSON Schema
   * cannot express (e.g. cross-field constraints, ID membership).
   */
  validateResponse?: (parsed: unknown) => void;

  // ─── Orchestration / observability ─────────────────────────────────────────
  costLabel?: string;
  logContext?: Record<string, string>;
  entityId?: string;
  entityType?: "thread" | "userComment" | "productModel";
  /**
   * Optional thread context for analytics. When set, the chat service emits
   * one canonical LLM-call accounting entry to DebugTraceService. Drives the
   * per-run cost / per-model usage recorded on ThreadRun.
   */
  threadId?: string;
  traceCollector?: (data: ChatTraceData) => void;
  maxRetries?: number;
  retryCount?: number;
}
