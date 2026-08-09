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

const DUPLICATE_THRESHOLD = 0.9;

@Injectable()
export class QuoteDuplicateDetector implements IssueDetector {
  readonly type: ValidationIssueType = "quote_duplicate";

  detect(ref: ProductReference, _ctx: DetectionContext): ValidationIssue[] {
    const out: ValidationIssue[] = [];
    const quotes = ref.quotes ?? [];
    if (quotes.length < 2) return out;
    const dropIds = new Set<string>();

    const normalized = quotes.map((q) => normalize(q.text ?? ""));
    for (let i = 0; i < quotes.length; i++) {
      if (dropIds.has(quotes[i].id)) continue;
      for (let j = i + 1; j < quotes.length; j++) {
        if (dropIds.has(quotes[j].id)) continue;
        const ratio = editDistanceRatio(normalized[i], normalized[j]);
        if (ratio < DUPLICATE_THRESHOLD) continue;
        // Pick poorer quality: shorter text is dropped.
        const dropIndex =
          (quotes[i].text?.length ?? 0) <= (quotes[j].text?.length ?? 0)
            ? i
            : j;
        const dropQuote = quotes[dropIndex];
        dropIds.add(dropQuote.id);
        out.push(
          buildValidationIssue("quote_duplicate", {
            source: "deterministic",
            droppedQuoteId: dropQuote.id,
            currentValue: dropQuote.text,
            reasoning: `near-duplicate ratio=${ratio.toFixed(2)} with ${dropIndex === i ? quotes[j].id : quotes[i].id}`,
            status: "pending",
          }),
        );
      }
    }
    return out;
  }
}
