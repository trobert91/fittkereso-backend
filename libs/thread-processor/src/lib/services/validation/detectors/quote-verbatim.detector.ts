import { Injectable } from "@nestjs/common";
import {
  ProductReference,
  ValidationIssue,
  ValidationIssueType,
} from "@ebike-backend/database";
import { editDistanceRatio, normalize } from "@ebike-backend/utils";
import {
  DetectionContext,
  IssueDetector,
} from "../../../interfaces/issue-detector.interface";
import { buildValidationIssue } from "../validation-issue-types";

const REWRITE_THRESHOLD = 0.9;
const WINDOW_STEP_RATIO = 0.5;

@Injectable()
export class QuoteVerbatimDetector implements IssueDetector {
  readonly type: ValidationIssueType = "quote_not_verbatim";

  detect(ref: ProductReference, ctx: DetectionContext): ValidationIssue[] {
    const out: ValidationIssue[] = [];
    const normalizedBody = normalize(ctx.commentBody ?? "");
    if (!normalizedBody) return out;

    for (const quote of ref.quotes ?? []) {
      const normalizedQuote = normalize(quote.text ?? "");
      if (!normalizedQuote) continue;
      if (normalizedBody.includes(normalizedQuote)) continue;

      const { ratio, nearMatch } = this.findNearestWindow(
        normalizedQuote,
        normalizedBody,
      );
      if (ratio >= REWRITE_THRESHOLD && nearMatch) {
        out.push(
          buildValidationIssue("quote_not_verbatim", {
            source: "deterministic",
            quoteId: quote.id,
            op: "rewrite",
            newText: nearMatch,
            currentValue: quote.text,
            reasoning: `Levenshtein=${ratio.toFixed(2)}`,
            status: "pending",
          }),
        );
      } else {
        out.push(
          buildValidationIssue("quote_not_verbatim", {
            source: "deterministic",
            quoteId: quote.id,
            op: "drop",
            currentValue: quote.text,
            reasoning: `no near match (best=${ratio.toFixed(2)})`,
            status: "pending",
          }),
        );
      }
    }
    return out;
  }

  private findNearestWindow(
    needle: string,
    haystack: string,
  ): { ratio: number; nearMatch?: string } {
    if (needle.length === 0 || haystack.length === 0) return { ratio: 0 };
    const windowSize = needle.length;
    const step = Math.max(1, Math.floor(windowSize * WINDOW_STEP_RATIO));
    let bestRatio = 0;
    let bestWindow: string | undefined;
    for (let i = 0; i + 1 <= haystack.length; i += step) {
      const end = Math.min(haystack.length, i + windowSize);
      const window = haystack.slice(i, end);
      const ratio = editDistanceRatio(needle, window);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestWindow = window;
        if (bestRatio >= 0.99) break;
      }
    }
    return { ratio: bestRatio, nearMatch: bestWindow };
  }
}
