import { ValidationIssue, ValidationIssueType } from "@ebike-backend/database";

export type IssueTypeAuthority = "deterministic" | "llm" | "both";

export interface IssueTypeDescriptor {
  /** Severity contribution per issue, summed into ref.issueSeverity. */
  magnitude: number;
  /** Which detection path may emit this type. */
  authority: IssueTypeAuthority;
  /** Human-readable description for admin UI tooltips and LLM prompts. */
  description: string;
}

export const VALIDATION_ISSUE_TYPES: Record<
  ValidationIssueType,
  IssueTypeDescriptor
> = {
  quote_not_verbatim: {
    magnitude: 10,
    authority: "deterministic",
    description:
      "Quote text does not match a passage in the comment body verbatim.",
  },
  quote_duplicate: {
    magnitude: 5,
    authority: "deterministic",
    description:
      "Two or more quotes on the same ref have effectively identical text.",
  },
  speculative_flag_mismatch: {
    magnitude: 10,
    authority: "llm",
    description:
      "Quote's `speculative` flag does not match the speaker's first-hand contact with what the quote describes. Bidirectional: a future-tense, hedged, or hearsay quote must have speculative=true; a concrete first-hand observation must have speculative=false (omit).",
  },
  wrong_sentiment: {
    magnitude: 30,
    authority: "llm",
    description:
      "Ref overall sentiment disagrees with the LLM's reading of the comment (auto-fixed).",
  },
  wrong_experience: {
    magnitude: 35,
    authority: "llm",
    description:
      "Ref experience tier disagrees with the LLM's reading of the comment (auto-fixed).",
  },
  wrong_depth: {
    magnitude: 25,
    authority: "llm",
    description:
      "Ref depth tier disagrees with the LLM's reading of the comment (auto-fixed).",
  },
  wrong_intent: {
    magnitude: 25,
    authority: "llm",
    description:
      "Ref intent set disagrees with the LLM's reading of the comment.",
  },
  wrong_product: {
    magnitude: 35,
    authority: "llm",
    description: "Ref resolved to a product the comment is not actually about.",
  },
  wrong_quote_attribution: {
    magnitude: 25,
    authority: "llm",
    description:
      "A quote on this ref is about a different product mentioned in the same comment.",
  },
  boundary_violation: {
    magnitude: 25,
    authority: "llm",
    description:
      "Ref content mixes evidence about multiple products that should be split or detached.",
  },
  discovered_products_present: {
    magnitude: 20,
    authority: "deterministic",
    description:
      "Identification surfaced product mentions that did not become refs.",
  },
  // identification-quality (V2)
  cheat_sheet_collapse_with_contrast_cue: {
    magnitude: 40,
    authority: "deterministic",
    description:
      'The comment body contains a contrast cue ("newer version", "(SD)" vs "(SB)") yet the LLM emitted the cheat-sheet model verbatim. Strong signal the ref is mis-identified.',
  },
  // extraction-quality
  wrong_quote_quality: {
    magnitude: 15,
    authority: "llm",
    description:
      "The labeled quote quality (high/medium/low) disagrees with the rubric — labeled high/medium when the quote has no evaluative content, or labeled low when it carries a first-hand verdict on a named aspect. Auto-fixed to the LLM's suggested value.",
  },
  // resolution-quality (V2)
  suffix_alpha_mismatch: {
    magnitude: 30,
    authority: "deterministic",
    description:
      'Input parsed suffix tokens differ from the candidate\'s suffix tokens (e.g. input "sd" vs candidate "su"). Today only blocks in strict mode; here it surfaces as an issue regardless of resolver mode.',
  },
  multiple_candidates_resolved: {
    magnitude: 35,
    authority: "deterministic",
    description:
      "Resolution emitted more than one candidate (the comment plausibly refers to multiple products, or the matcher/LLM found multiple plausible identities above threshold). Held for human review via the per-issue high-severity gate (magnitude >= 20). Ranks above unresolved_after_search because picking between known candidates is faster human work than identifying a new product.",
  },
  low_recency_evidence: {
    magnitude: 15,
    authority: "deterministic",
    description:
      'The OP comment contained recency or pricing cues ("newer version", "Don\'t Pay $X", "$Y") that the matcher did not use. Soft signal on its own — combines with other issues to push a ref over the review threshold.',
  },
  resolved_via_web_search: {
    magnitude: 35,
    authority: "deterministic",
    description:
      "The product the ref resolved to is a speculative identity: it was newly created during pipeline resolution from a web-search result rather than coming from a structured catalog source (arukereso, displaySpecs, manual). Auto-clears once a structured-source row appears.",
  },
  unresolved_after_search: {
    // Recalibrated 40 → 30. With UNRESOLVED_REF_SEVERITY (25) the effective
    // per-ref contribution stays at 55 (still ≥ openSeverityReviewThreshold);
    // ranks below multiple_candidates_resolved (35) in queue prioritization
    // because picking between known candidates is faster than identifying a
    // new product from scratch.
    magnitude: 30,
    authority: "deterministic",
    description:
      "The resolver returned no candidate (resolvedModel == null) on a category that has search enabled. The ref is held for review so systematic alias gaps surface in the moderation queue.",
  },
  duplicate_model: {
    magnitude: 35,
    authority: "deterministic",
    description:
      "Two or more refs on the same comment have overlapping candidate sets — the same catalog product model appears in both refs' candidates list. Strong signal one of them should map to a different (likely catalog-missing) variant. Fires even when one or both refs are disabled. Surfacing-only — human review picks which ref keeps the product.",
  },
};

export const LLM_EMITTABLE_TYPES = (
  Object.entries(VALIDATION_ISSUE_TYPES) as [
    ValidationIssueType,
    IssueTypeDescriptor,
  ][]
)
  .filter(([, d]) => d.authority === "llm" || d.authority === "both")
  .map(([type]) => type);

/**
 * Construct a `ValidationIssue` with `magnitude` stamped from the descriptor
 * table. The single emission path — every detector and LLM-issue builder
 * routes through here, so consumers (severity loop, admin UI) can read
 * `issue.magnitude` directly without re-deriving it from the type.
 */
export function buildValidationIssue<T extends ValidationIssueType>(
  type: T,
  fields: Omit<Extract<ValidationIssue, { type: T }>, "type" | "magnitude">,
): Extract<ValidationIssue, { type: T }> {
  return {
    type,
    magnitude: VALIDATION_ISSUE_TYPES[type].magnitude,
    ...fields,
  } as Extract<ValidationIssue, { type: T }>;
}
