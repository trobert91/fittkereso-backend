import { Depth, ExperienceType, Intent, Sentiment } from '../postgres';
import type { ContentQuality } from './product-resolution-context';

export type ValidationIssueSource = 'deterministic' | 'llm';

export type ValidationIssueType =
  // verbatim / quote integrity (deterministic)
  | 'quote_not_verbatim'
  | 'quote_duplicate'
  // metadata consistency (deterministic)
  | 'speculative_flag_mismatch'
  // ref-level scalar corrections (deterministic and/or LLM, see authority)
  | 'wrong_sentiment'
  | 'wrong_experience'
  | 'wrong_depth'
  | 'wrong_intent'
  // ref integrity
  | 'wrong_product'
  | 'wrong_quote_attribution'
  | 'boundary_violation'
  // prior-step observation carryovers (deterministic)
  | 'discovered_products_present'
  // identification-quality (deterministic, V2)
  | 'cheat_sheet_collapse_with_contrast_cue'
  // extraction-quality (LLM)
  | 'wrong_quote_quality'
  // resolution-quality (deterministic, V2)
  | 'suffix_alpha_mismatch'
  | 'multiple_candidates_resolved'
  | 'low_recency_evidence'
  | 'resolved_via_web_search'
  | 'unresolved_after_search'
  | 'duplicate_model';

export type IssueStatus =
  | 'pending'
  | 'resolved'
  | 'unresolved'
  | 'unresolvable';

interface IssueCommon {
  source: ValidationIssueSource;
  /** Severity contribution of this issue. Stamped from the issue-type
   *  descriptor at creation time so consumers don't need the descriptor table
   *  to compute or display severity. Persisted with the issue. */
  magnitude: number;
  reasoning?: string;
  status: IssueStatus;
  resolutionFailedReason?: string;
}

export type ValidationIssue =
  // ── Resolvable: ref-scalar assignments ──────────────────────────────────
  | (IssueCommon & {
      type: 'wrong_sentiment';
      currentValue?: Sentiment;
      suggestedValue: Sentiment;
    })
  | (IssueCommon & {
      type: 'wrong_experience';
      currentValue?: ExperienceType;
      suggestedValue: ExperienceType;
    })
  | (IssueCommon & {
      type: 'wrong_depth';
      currentValue?: Depth;
      suggestedValue: Depth;
    })
  | (IssueCommon & {
      type: 'wrong_intent';
      currentValue?: Intent[];
      suggestedValue: Intent[];
    })
  // ── Resolvable: quote operations ────────────────────────────────────────
  | (IssueCommon & {
      type: 'quote_not_verbatim';
      quoteId: string;
      op: 'rewrite' | 'drop';
      newText?: string;
      currentValue: string;
    })
  | (IssueCommon & {
      type: 'quote_duplicate';
      droppedQuoteId: string;
      currentValue: string;
    })
  | (IssueCommon & {
      type: 'speculative_flag_mismatch';
      quoteId: string;
      suggestedValue: boolean;
    })
  // ── Unresolvable: surfacing-only ────────────────────────────────────────
  | (IssueCommon & {
      type: 'wrong_product';
    })
  | (IssueCommon & {
      type: 'wrong_quote_attribution';
      quoteId?: string;
    })
  | (IssueCommon & {
      type: 'boundary_violation';
    })
  | (IssueCommon & {
      type: 'discovered_products_present';
    })
  // ── Surfacing-only V2 deterministic types ───────────────────────────────
  | (IssueCommon & {
      type: 'cheat_sheet_collapse_with_contrast_cue';
    })
  | (IssueCommon & {
      type: 'wrong_quote_quality';
      quoteId: string;
      currentValue?: ContentQuality;
      suggestedValue: ContentQuality;
    })
  | (IssueCommon & {
      type: 'suffix_alpha_mismatch';
    })
  | (IssueCommon & {
      type: 'multiple_candidates_resolved';
    })
  | (IssueCommon & {
      type: 'low_recency_evidence';
    })
  | (IssueCommon & {
      type: 'resolved_via_web_search';
    })
  | (IssueCommon & {
      type: 'unresolved_after_search';
    })
  | (IssueCommon & {
      type: 'duplicate_model';
      /** Every ref on this comment whose candidate set intersects at least one
       *  other ref's candidate set on the same comment. */
      refIds: string[];
      /** Catalog product model ids that appear in 2+ refs' candidate sets. */
      sharedModelIds: string[];
    });
