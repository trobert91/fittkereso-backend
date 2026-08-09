/**
 * CommentContext — lightweight pipeline state for debugging.
 *
 * Stored as JSONB on UserComment.context. ProductReference entities
 * are the authoritative source for extracted/resolved product data.
 *
 * Pipeline stages:
 *   1. Planner-Identifier (merged) → productMentions[] (kept for debugging)
 *   2. Extractor                   → ProductReference entities (authoritative)
 *   3. Resolver                    → ProductReference.resolvedModel (authoritative)
 */

// ─── Sub-types ────────────────────────────────────────────────────────────────

import { Depth, ExperienceType, Intent, Sentiment } from '../postgres';
import type { ContentQuality } from './product-resolution-context';
import type { ValidationIssue } from './validation-issue';

export type MentionType = 'explicit' | 'implicit';

/**
 * Single piece of label evidence emitted by the labeling LLM.
 *
 * Used across three peer arrays:
 *   - `Quote.features` / `ProductReference.features`
 *   - `Quote.useCases` / `ProductReference.useCases`
 *   - `Quote.issues` (quote-level only — there is no ref-level issues array)
 *
 * Sentiment semantics:
 *   - Quote-level feature/useCase evidence: `sentiment` is optional and
 *     inherits from the enclosing quote when absent (see `effectiveSentiment`).
 *   - Reference-level evidence: `sentiment` should be set explicitly; there
 *     is no enclosing quote to inherit from.
 *   - Issue evidence: `sentiment` is always set and clamped to
 *     `Sentiment.Negative` or `Sentiment.StrongNegative` (severity dimension).
 *     This invariant is enforced by the labeler schema and a programmatic
 *     coercion before persistence; readers can rely on it being present.
 */
export interface Evidence {
  label: string;
  sentiment?: Sentiment;
}

/**
 * The sentiment that applies to this evidence's label. If the evidence
 * carries its own sentiment, it overrides the quote's sentiment;
 * otherwise the label inherits from the quote.
 */
export function effectiveSentiment(
  evidence: Evidence,
  quote: Quote,
): Sentiment {
  return evidence.sentiment ?? quote.sentiment;
}

export interface ReferenceDetails {
  returned?: boolean;
  defective?: boolean;
  multipleUnits?: boolean;
}

/** Aggregated details across all ProductReferences in a review. */
export interface ReviewDetails {
  returned?: boolean;
  defective?: boolean;
  multipleUnits?: boolean;
}

export interface Quote {
  id: string;
  text: string;
  sentiment: Sentiment;
  speculative?: boolean;
  features?: Evidence[];
  useCases?: Evidence[];
  /**
   * Issue evidence — quote-level only (no ref-level counterpart).
   * Each entry has `label` set to a closed-list issue type and `sentiment`
   * always set to `Sentiment.Negative` or `Sentiment.StrongNegative`.
   * Parent feature mapping is resolved at scoring time via the category
   * config's `IssueLabelConfig.feature`, not stored here.
   */
  issues?: Evidence[];
  quality?: ContentQuality;
}

export interface ParentProductContext {
  id: string;
  brand: string;
  displayName: string;
  model: string;
  category?: string;
  specs: string[];
  priority: number;
  priorityIndicator?: string;
}

export interface ParentContext {
  products: ParentProductContext[];
}

// ─── Pipeline Types ───────────────────────────────────────────────────────────

/** Output of merged Planner-Identifier stage */
export interface ProductMention {
  textSpans: string[];
  productId?: string; // Present if matched to parent
  brand: string;
  model: string;
  displayName: string;
  category: string;
  confidence: number; // 0-1
  specs?: string[]; // All explicitly mentioned specs from the comment
}

/** Output of Extractor stage */
export interface ExtractedProduct extends ProductMention {
  quotes: Quote[];
  intents: Intent[];
  sentiment: Sentiment;
  experience: ExperienceType;
  depth: Depth;
}

/** Output of Product Resolution stage (final DB matching) */
export interface ResolvedProduct extends ExtractedProduct {
  productId: string; // Now required
  dbMatched: boolean;
  dbConfidence: number;
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class CommentContext {
  commentBody: string;
  parentCommentBody?: string;

  /**
   * Stage 1 — Merged Planner-Identifier output.
   * Kept for debugging purposes. ProductReference entities are the authoritative source.
   */
  productMentions: ProductMention[] = [];

  /**
   * Comment-level validation issues — concerns that span multiple refs on
   * this comment (e.g. `duplicate_model`). Per-ref issues live on
   * `ProductReference.context.issues`.
   */
  issues?: ValidationIssue[];

  constructor(init?: Partial<CommentContext>) {
    if (init) {
      Object.assign(this, init);
    }
  }

  /**
   * TypeORM transformer to hydrate plain JSONB objects into CommentContext instances.
   */
  static transformer = {
    to: (value: CommentContext | null | undefined) => {
      // Store as plain object
      return value ? JSON.parse(JSON.stringify(value)) : null;
    },
    from: (value: any) => {
      // Hydrate back into class instance
      return value ? new CommentContext(value) : null;
    },
  };

  // ── Pipeline utilities ────────────────────────────────────────────────────

  addProductMention(mention: ProductMention): void {
    this.productMentions.push(mention);
  }
}
