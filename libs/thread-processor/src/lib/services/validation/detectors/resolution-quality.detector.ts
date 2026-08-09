import { Injectable } from "@nestjs/common";
import {
  getPrimaryModel,
  isUnresolved,
  ProductReference,
  ValidationIssue,
  ValidationIssueType,
} from "@ebike-backend/database";
import {
  DetectionContext,
  IssueDetector,
} from "../../../interfaces/issue-detector.interface";
import { buildValidationIssue } from "../validation-issue-types";

/**
 * Recency / pricing cues that the matcher does not currently consume. When the
 * ref's own quotes contain one of these AND the candidate has no `releaseYear`
 * signal, fire `low_recency_evidence` as a soft hint that disambiguation
 * evidence was available but unused. Scoped to the ref's quotes (not the whole
 * comment body) so a cue attached to a sibling product's evidence does not
 * flag this ref.
 */
const RECENCY_CUE_PATTERNS: readonly RegExp[] = [
  /\bnewer\b/i,
  /\bolder\b/i,
  /\bdon't pay\b/i,
  /\$\d+/,
  /\bsale\b/i,
  /\bdiscount\b/i,
  /\bdiscounted\b/i,
  /\bclearance\b/i,
];

/**
 * Reads `ref.searchContext` and `ref.candidates`. Emits issues that surface
 * the resolver's quality without re-running it.
 *
 * Issues:
 * - `suffix_alpha_mismatch` — input model and matched candidate disagree on
 *   trailing alpha tokens (heuristic). Today only blocks in strict mode.
 * - `multiple_candidates_resolved` — `ref.candidates.length > 1`. The single
 *   in-review signal for ambiguous resolutions; subsumes the legacy
 *   `ambiguous_match` issue (which keyed off a score-gap heuristic — obsolete
 *   now that the matcher path emits all above-threshold candidates and the
 *   LLM path returns 1..N picks directly).
 * - `low_recency_evidence` — ref's quotes carry a recency/pricing cue and
 *   the resolved candidate has no release-year signal.
 * - `resolved_via_web_search` — the winning candidate originated from the
 *   web-research recall path (`source === 'web'`). Surfaces resolutions
 *   driven by SERP evidence rather than the local catalog matcher.
 * - `unresolved_after_search` — no candidate returned on a search-enabled
 *   category. Held for review so alias gaps surface in moderation.
 */
@Injectable()
export class ResolutionQualityDetector implements IssueDetector {
  readonly type: ValidationIssueType = "unresolved_after_search";

  detect(ref: ProductReference, _ctx: DetectionContext): ValidationIssue[] {
    const out: ValidationIssue[] = [];

    const bestAlias = ref.searchContext?.scoring?.bestCandidate?.alias;
    const resolvedModel = getPrimaryModel(ref);
    const unresolvedAfterSearch =
      isUnresolved(ref) && ref.productCategory?.searchEnabled === true;

    // 1. suffix_alpha_mismatch — heuristic against trailing alpha tokens.
    //    The matcher's suffix tokens are not exposed on `MatchResult`; deriving
    //    them via `InputNormalizationService.parseModelCode` would couple this
    //    detector to the resolver's parsing config. Use a simple inline rule:
    //    extract the last 2-3 trailing letters of the input model and the
    //    candidate alias; fire when they exist and disagree.
    if (bestAlias) {
      const inputModel = ref.context?.identification?.model ?? "";
      const inputSuffix = this.extractTrailingAlpha(inputModel);
      const candidateSuffix = this.extractTrailingAlpha(bestAlias);
      if (
        inputSuffix.length >= 2 &&
        candidateSuffix.length >= 2 &&
        inputSuffix !== candidateSuffix
      ) {
        out.push(
          buildValidationIssue("suffix_alpha_mismatch", {
            source: "deterministic",
            status: "pending",
            reasoning: `Input model trailing alpha "${inputSuffix}" disagrees with candidate alias trailing alpha "${candidateSuffix}".`,
          }),
        );
      }
    }

    // 2. multiple_candidates_resolved — fires whenever the applier persisted
    //    more than one candidate, regardless of which path produced them
    //    (matcher_accept with multiple above-threshold scores OR llm_resolved
    //    with N picks). Magnitude 35 ≥ per-issue gate 20 → IN_REVIEW
    //    regardless of cumulative severity.
    const candidateCount = (ref.candidates ?? []).length;
    if (candidateCount > 1) {
      const candidateNames = (ref.candidates ?? [])
        .map(
          (candidate) =>
            candidate.model?.displayName ?? candidate.model?.id ?? "unknown",
        )
        .join(", ");
      out.push(
        buildValidationIssue("multiple_candidates_resolved", {
          source: "deterministic",
          status: "pending",
          reasoning:
            `Resolution emitted ${candidateCount} candidates (${candidateNames}). ` +
            `Held for human review.`,
        }),
      );
    }

    // 3. low_recency_evidence — recency cue present in this ref's quotes,
    //    candidate has no releaseYear. Quote-scoped so a cue attached to a
    //    sibling product's evidence does not flag this ref.
    if (this.refQuotesHaveRecencyCue(ref) && resolvedModel) {
      const releaseYear = resolvedModel.releaseYear;
      if (releaseYear === undefined || releaseYear === null) {
        out.push(
          buildValidationIssue("low_recency_evidence", {
            source: "deterministic",
            status: "pending",
            reasoning:
              'Ref\'s quotes contain a recency or pricing cue (e.g. "newer version", discount language) but the resolved candidate has no releaseYear signal.',
          }),
        );
      }
    }

    // 4. resolved_via_web_search — any accepted candidate appeared in the
    //    SERP evidence collected by web research. Reading `searchEvidence` is
    //    necessary because the recall pool's `source` field is unreliable:
    //    when fuzzy and web both produce the same productId, `RecallService`
    //    keeps whichever has the higher matchScore, and at recall time web
    //    entries have no score yet — so fuzzy almost always overwrites web.
    //    The persisted `searchEvidence[*].resolvedProducts[*].productId`
    //    records what web independently surfaced, regardless of merge order.
    //    Checking every accepted candidate (not just the primary) covers
    //    multi-pick decisions (matcher_accept with multiple above-threshold or
    //    llm_resolved with N picks) — any web-sourced pick triggers the issue.
    if (resolvedModel) {
      const webRan = ref.searchContext?.strategiesRun?.includes("web") ?? false;
      if (webRan) {
        const acceptedProductIds = new Set(
          (ref.candidates ?? [])
            .map((candidate) => candidate.model?.id)
            .filter((id): id is string => !!id),
        );
        const webSurfacedIds = new Set<string>();
        for (const record of ref.searchContext?.searchEvidence ?? []) {
          for (const resolved of record.resolvedProducts ?? []) {
            if (acceptedProductIds.has(resolved.productId)) {
              webSurfacedIds.add(resolved.productId);
            }
          }
        }
        if (webSurfacedIds.size > 0) {
          const detail =
            webSurfacedIds.size === acceptedProductIds.size
              ? "every accepted candidate"
              : `${webSurfacedIds.size} of ${acceptedProductIds.size} accepted candidates`;
          out.push(
            buildValidationIssue("resolved_via_web_search", {
              source: "deterministic",
              status: "pending",
              reasoning: `Web-research recall surfaced ${detail} via SERP evidence. Held for review so SERP-driven resolutions can be audited.`,
            }),
          );
        }
      }
    }

    // 5. unresolved_after_search — no match returned, but the category had
    //    search enabled.
    if (unresolvedAfterSearch) {
      out.push(
        buildValidationIssue("unresolved_after_search", {
          source: "deterministic",
          status: "pending",
          reasoning:
            "Resolver returned no candidate on a category that has searchEnabled=true; held for review so systematic alias gaps surface in the moderation queue.",
        }),
      );
    }

    return out;
  }

  /** Extract trailing alpha letters from a model string ("S34DG850SU" → "SU"). */
  private extractTrailingAlpha(s: string): string {
    if (!s) return "";
    const match = s.match(/[A-Za-z]+$/);
    return match ? match[0].toUpperCase() : "";
  }

  private refQuotesHaveRecencyCue(ref: ProductReference): boolean {
    const text = (ref.quotes ?? []).map((q) => q.text ?? "").join(" ");
    if (!text) return false;
    return RECENCY_CUE_PATTERNS.some((re) => re.test(text));
  }
}
