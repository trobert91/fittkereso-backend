import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import { ChatTraceData } from "@ebike-backend/debug";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ImageAnalyzerParams {
  imageUrl: string;
  model: string;
  threadId?: string;
  traceCollector?: (data: ChatTraceData) => void;
}

interface ImageAnalysisResult {
  hasUsefulContent: boolean;
  content: string;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const IMAGE_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    hasUsefulContent: {
      type: "boolean",
      description:
        "true if the image contains actionable product information (names, specs, prices)",
    },
    content: {
      type: "string",
      description:
        "Extracted product information text. Empty string if not useful.",
    },
  },
  required: ["hasUsefulContent", "content"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  "You are extracting product information from an image attached to a Reddit post.",
  "Only extract text that is completely clear and fully legible in the image.",
  "If the image does not contain product information (memes, setup photos, screenshots without product details), mark as not useful.",
  "",
  "Rules:",
  "- Report only text you can read with 100% certainty — skip anything blurry, angled, partially obscured, or ambiguous",
  "- Never complete, guess, or reconstruct partial text",
  "- Preserve exact spelling of product names, model numbers, and specifications",
  "- Include prices if visible",
  "- Do not describe the image or its layout",
  "- Output only confirmed facts — no qualifiers, no hedging, no commentary",
].join("\n");

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class ImageAnalyzerService {
  private readonly logger = new CustomLogger(ImageAnalyzerService.name);

  constructor(private readonly aiChat: AiChatService) {}

  async analyze(params: ImageAnalyzerParams): Promise<string | null> {
    const { imageUrl, model, threadId, traceCollector } = params;

    const response = await this.aiChat.createChat({
      costLabel: "image_analysis",
      logContext: { imageUrl },
      threadId,
      schema: IMAGE_ANALYSIS_SCHEMA,
      schemaName: "image_analysis",
      traceCollector,
      maxRetries: 1,
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this image from a Reddit product discussion.",
            },
            {
              type: "image_url",
              image_url: { url: imageUrl, detail: "high" },
            },
          ],
        },
      ],
      temperature: 1,
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      this.logger.warn("Image analysis returned empty content");
      return null;
    }

    const result: ImageAnalysisResult = JSON.parse(raw);

    if (!result.hasUsefulContent || !result.content) {
      this.logger.debug("Image did not contain useful product information", {
        imageUrl,
      });
      return null;
    }

    this.logger.debug("Image analysis extracted product content", {
      imageUrl,
      contentLength: result.content.length,
    });

    return result.content;
  }
}
