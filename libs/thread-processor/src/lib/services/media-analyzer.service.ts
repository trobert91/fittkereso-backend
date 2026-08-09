import { Injectable } from "@nestjs/common";
import { CommentMedia } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { ChatTraceData } from "@ebike-backend/debug";
import { isEmpty } from "lodash";
import { ImageAnalyzerService } from "./image-analyzer.service";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MediaAnalyzerParams {
  media: CommentMedia[];
  model: string;
  threadId?: string;
  traceCollector?: (data: ChatTraceData) => void;
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class MediaAnalyzerService {
  private readonly logger = new CustomLogger(MediaAnalyzerService.name);

  constructor(private readonly imageAnalyzer: ImageAnalyzerService) {}

  async analyze(params: MediaAnalyzerParams): Promise<CommentMedia[]> {
    const { media, model, threadId, traceCollector } = params;

    const result: CommentMedia[] = [];

    for (const entry of media) {
      // Already analyzed — keep as-is
      if (entry.content) {
        result.push(entry);
        continue;
      }

      if (entry.type === "image" && !isEmpty(entry.url)) {
        try {
          const content = await this.imageAnalyzer.analyze({
            imageUrl: entry.url,
            model,
            threadId,
            traceCollector,
          });
          result.push({ ...entry, content: content ?? undefined });
        } catch (error) {
          this.logger.warn("Image analysis failed, skipping", {
            imageUrl: entry.url,
            error,
          });
          result.push(entry);
        }
        continue;
      }

      // Unsupported type (e.g. 'link') — pass through unchanged
      result.push(entry);
    }

    return result;
  }
}
