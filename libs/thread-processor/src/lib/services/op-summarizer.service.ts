import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import { ChatTraceData } from "@ebike-backend/debug";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OPSummarizerOptions {
  opSummaryThreshold: number;
  opSummarizerModel: string;
  thinking?: boolean;
  effort?: string;
}

// Regex: brand-like word(s) followed by model-number-like token (letters + digits or digit + letter combos)
// Examples: "Samsung S95C", "LG 42C4", "Alienware AW3225QF", "Dell S3222DGM"
const PRODUCT_NAME_REGEX =
  /\b([A-Z][a-zA-Z]*(?:\s[A-Z][a-zA-Z]*)?)[\s-]([A-Z0-9](?:[A-Za-z0-9\-./]){2,})\b/g;

@Injectable()
export class OPSummarizerService {
  private readonly logger = new CustomLogger(OPSummarizerService.name);

  constructor(private readonly aiChat: AiChatService) {}

  /**
   * Returns the OP text to use for prompts.
   * - If body ≤ threshold → returns body as-is.
   * - If opSummary already exists → returns it as-is.
   * - Otherwise → calls LLM to summarize, validates product mentions, returns summary.
   *
   * The caller is responsible for persisting the returned summary to op.opSummary.
   */
  async summarizeIfNeeded(
    body: string,
    existingOpSummary: string | null | undefined,
    opts: OPSummarizerOptions,
    threadId: string,
    traceCollector?: (data: ChatTraceData) => void,
  ): Promise<string> {
    // Already summarized
    if (existingOpSummary && existingOpSummary.length > 0) {
      return existingOpSummary;
    }

    // Short enough — no summarization needed
    if (body.length <= opts.opSummaryThreshold) {
      return body;
    }

    // LLM summarization
    const targetLength = Math.round(opts.opSummaryThreshold * 0.85);
    const summary = await this.summarize(
      body,
      opts.opSummarizerModel,
      targetLength,
      threadId,
      traceCollector,
      opts.thinking,
      opts.effort,
    );

    // Deterministic safety net — append any missing product names, capped at threshold
    return this.validateProducts(body, summary, opts.opSummaryThreshold);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async summarize(
    body: string,
    model: string,
    targetLength: number,
    threadId: string,
    traceCollector?: (data: ChatTraceData) => void,
    thinking?: boolean,
    effort?: string,
  ): Promise<string> {
    const systemPrompt = [
      'You are summarizing a product-discussion post. Your output will be reused as OP context in downstream LLM calls that extract and identify product references from reply comments in this thread. Those calls need to disambiguate informal mentions like "the LG" or "the MSI" back to the specific products the OP introduced — so the summary\'s job is to anchor every product the OP names with enough context for that disambiguation to work.',
      "",
      "For every product the OP names, capture:",
      '1. Exact brand + model identifier verbatim (e.g. "LG 34GS95QE-B", "MSI MPG 341CQPX", "AW3225QF"). Never paraphrase or shorten model numbers; preserve suffixes like "-B".',
      '2. Primary specs the OP names for that product — panel type, size, resolution, refresh rate, curvature, certifications, and any other distinguishing attributes the OP mentions. Only specs the OP actually states; do not invent. e.g. "glossy QD-OLED, 1800R, 240 Hz" or "matte WOLED, 800R, certified G-sync".',
      '3. Shorthand and aliases the OP uses to refer to that product — short forms like "the LG" / "the MSI" / "ROG" and descriptor-based references like "glossy QD-OLED" / "matte WOLED" / "the 1800R one" when the OP uses them. Capture them verbatim so downstream calls can resolve those same mentions in reply comments.',
      "4. The author's stance on that product: leaning toward, leaning against, dismissed, neutral comparison anchor.",
      '5. The 1-2 specific concerns or appeals the author has for that product (e.g. "worried about glossy QD-OLED grey tint", "likes 1800R curve for media", "concerned about G-sync stability").',
      "6. The author's experience with that product if stated: owns, previously owned, returned, just researching, considering.",
      "",
      "Also include:",
      "- The author's use case (gaming, work, media, mixed).",
      "- Key constraints (budget, room conditions, paired hardware, size/refresh/panel requirements).",
      "",
      "Format:",
      "- Concise prose. Aim for one short sentence or clause per product.",
      "- Lead with use case and constraints, then walk through products.",
      '- Group products with the same stance when natural ("dismissing X and Y because…").',
      "",
      "Rules:",
      `- Target length: ~${targetLength} characters.`,
      "- Never invent products not in the original.",
      '- Keep brand + model identifiers exact, including suffixes like "-B" or trailing letters.',
      "- Skip greetings, sign-offs, and edit-meta lines that don't add product information.",
    ].join("\n");

    const response = await this.aiChat.createChat({
      costLabel: "op_summarization",
      logContext: { threadId, targetLength: String(targetLength) },
      threadId,
      traceCollector,
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: body },
      ],
      temperature: 1,
      ...(thinking !== undefined && { thinking }),
      ...(effort !== undefined && { effort }),
    });

    const content = response.choices[0]?.message?.content ?? "";

    if (!content) {
      this.logger.warn(
        "OP summarization returned empty content, falling back to original body",
      );
      return body;
    }

    return content;
  }

  /**
   * Extract product names from original text, check each is present
   * in the summary, and append any missing ones — but only if the
   * appendix fits within the threshold. Missing products that don't
   * fit are still surfaced via the per-subtree cheat sheet.
   */
  private validateProducts(
    original: string,
    summary: string,
    threshold: number,
  ): string {
    const originalProducts = this.extractProductNames(original);
    if (originalProducts.length === 0) return summary;

    const summaryLower = summary.toLowerCase();
    const missing = originalProducts.filter(
      (name) => !summaryLower.includes(name.toLowerCase()),
    );

    if (missing.length === 0) return summary;

    const appendix = `\nAlso mentioned: ${missing.join(", ")}`;
    if (summary.length + appendix.length > threshold) {
      this.logger.debug(
        `OP summary appendix would exceed threshold (${threshold}); skipping. Missing: ${missing.join(", ")} (still in cheat sheet)`,
      );
      return summary;
    }

    this.logger.debug(
      `OP summary missing ${missing.length} product(s), appending: ${missing.join(", ")}`,
    );

    return `${summary}${appendix}`;
  }

  private extractProductNames(text: string): string[] {
    const names = new Set<string>();
    let match: RegExpExecArray | null;

    // Reset regex state
    PRODUCT_NAME_REGEX.lastIndex = 0;
    while ((match = PRODUCT_NAME_REGEX.exec(text)) !== null) {
      const fullName = match[0].trim();
      names.add(fullName);
    }

    return Array.from(names);
  }
}
