import { Injectable } from "@nestjs/common";
import { ProductReference, ValidationIssue } from "@ebike-backend/database";
import { findQuote } from "./quote-field-helpers";

@Injectable()
export class IssueResolver {
  /**
   * Apply each issue's resolution and finalize its status.
   * Pure dispatch on issue.type.
   */
  apply(ref: ProductReference, issues: ValidationIssue[]): ValidationIssue[] {
    for (const issue of issues) {
      this.resolve(ref, issue);
    }
    return issues;
  }

  private resolve(ref: ProductReference, issue: ValidationIssue): void {
    switch (issue.type) {
      case "wrong_sentiment":
        ref.sentiment = issue.suggestedValue;
        issue.status = "resolved";
        return;
      case "wrong_experience":
        ref.experience = issue.suggestedValue;
        issue.status = "resolved";
        return;
      case "wrong_depth":
        ref.depth = issue.suggestedValue;
        issue.status = "resolved";
        return;
      case "wrong_intent":
        ref.intents = issue.suggestedValue;
        issue.status = "resolved";
        return;

      case "quote_not_verbatim": {
        const quote = findQuote(ref, issue.quoteId);
        if (!quote) {
          issue.status = "unresolved";
          issue.resolutionFailedReason = `quote ${issue.quoteId} not present`;
          return;
        }
        if (issue.op === "rewrite") {
          if (issue.newText === undefined) {
            issue.status = "unresolved";
            issue.resolutionFailedReason = "op=rewrite without newText";
            return;
          }
          quote.text = issue.newText;
        } else {
          ref.quotes = (ref.quotes ?? []).filter((q) => q.id !== issue.quoteId);
        }
        issue.status = "resolved";
        return;
      }
      case "quote_duplicate": {
        const quote = findQuote(ref, issue.droppedQuoteId);
        if (!quote) {
          issue.status = "unresolved";
          issue.resolutionFailedReason = `quote ${issue.droppedQuoteId} not present`;
          return;
        }
        ref.quotes = (ref.quotes ?? []).filter(
          (q) => q.id !== issue.droppedQuoteId,
        );
        issue.status = "resolved";
        return;
      }
      case "speculative_flag_mismatch": {
        const quote = findQuote(ref, issue.quoteId);
        if (!quote) {
          issue.status = "unresolved";
          issue.resolutionFailedReason = `quote ${issue.quoteId} not present`;
          return;
        }
        quote.speculative = issue.suggestedValue;
        issue.status = "resolved";
        return;
      }

      case "wrong_quote_quality": {
        const quote = findQuote(ref, issue.quoteId);
        if (!quote) {
          issue.status = "unresolved";
          issue.resolutionFailedReason = `quote ${issue.quoteId} not present`;
          return;
        }
        quote.quality = issue.suggestedValue;
        issue.status = "resolved";
        return;
      }

      case "wrong_product":
      case "wrong_quote_attribution":
      case "boundary_violation":
      case "discovered_products_present":
      // V2 surfacing-only deterministic types — no auto-fix path; they exist
      // to feed `openIssueSeverity` and (for some) the moderation queue.
      case "cheat_sheet_collapse_with_contrast_cue":
      case "suffix_alpha_mismatch":
      case "multiple_candidates_resolved":
      case "low_recency_evidence":
      case "resolved_via_web_search":
      case "unresolved_after_search":
      case "duplicate_model":
        issue.status = "unresolvable";
        return;

      default: {
        const _exhaustive: never = issue;
        return _exhaustive;
      }
    }
  }
}
