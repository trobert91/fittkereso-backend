import { Injectable } from "@nestjs/common";
import {
  ProductReference,
  ProductResolutionInput,
  StructuredSpec,
  UserComment,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { normalizeModelName } from "@ebike-backend/utils";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { SubtreeNode } from "../models/subtree.model";
import { ThreadContext } from "../models/thread-context";
import { distance as levenshtein } from "fastest-levenshtein";
import { referenceToResolutionInput } from "./reference-to-resolution-input";

// ─── AncestryIndex ────────────────────────────────────────────────────────────

export interface AncestryIndex {
  /** externalId → set of ancestor externalIds (walking up to root) */
  ancestors: Map<string, Set<string>>;
  /** externalId → set of descendant externalIds (all plan nodes whose ancestry includes this node) */
  descendants: Map<string, Set<string>>;
}

/**
 * Build a bidirectional ancestry index for the plan nodes in a subtree.
 * This is O(n × depth) but built once per subtree and reused for all resolution calls.
 */
export function buildAncestryIndex(
  planNodes: SubtreeNode[],
  context: ThreadContext,
): AncestryIndex {
  const ancestors = new Map<string, Set<string>>();
  const descendants = new Map<string, Set<string>>();

  for (const node of planNodes) {
    const ancestorIds = new Set<string>();

    let current = node.comment.parent?.externalId
      ? context.getByExternalId(node.comment.parent.externalId)
      : undefined;

    while (current) {
      ancestorIds.add(current.externalId);

      let descendantSet = descendants.get(current.externalId);
      if (!descendantSet) {
        descendantSet = new Set();
        descendants.set(current.externalId, descendantSet);
      }
      descendantSet.add(node.comment.externalId);

      current = current.parent?.externalId
        ? context.getByExternalId(current.parent.externalId)
        : undefined;
    }

    ancestors.set(node.comment.externalId, ancestorIds);
  }

  return { ancestors, descendants };
}

// ─── isSameProduct ────────────────────────────────────────────────────────────

function isLetter(char: string): boolean {
  return /[a-zA-Z]/.test(char);
}

/**
 * Determine whether two brand+model pairs refer to the same product.
 *
 * Rules:
 * 1. Brand mismatch → false (when both are present)
 * 2. Exact normalized model match → true
 * 3. Containment with token-boundary guard → true
 *    Boundary: space, hyphen, or letter↔digit transition
 * 4. Otherwise → false
 *
 * Uses `normalizeModelName` (collapses letter-digit whitespace, preserves hyphens):
 * "MPG 341" → "MPG341", "341 CQPX" → "341CQPX", "341CQP-DE" → "341CQP-DE"
 */
export function isSameProduct(
  brandA: string | undefined,
  modelA: string | undefined,
  brandB: string | undefined,
  modelB: string | undefined,
): boolean {
  if (!modelA || !modelB) return false;

  if (brandA && brandB && brandA.toLowerCase() !== brandB.toLowerCase()) {
    return false;
  }

  const normA = normalizeModelName(modelA).toLowerCase();
  const normB = normalizeModelName(modelB).toLowerCase();

  if (normA === normB) return true;

  const [shorter, longer] =
    normA.length <= normB.length ? [normA, normB] : [normB, normA];

  const index = longer.indexOf(shorter);
  if (index === -1) return false;

  // Guard the left boundary
  if (index > 0) {
    const charBefore = longer[index - 1];
    const isLetterDigitTransition =
      isLetter(charBefore) !== isLetter(shorter[0]);
    if (charBefore !== " " && charBefore !== "-" && !isLetterDigitTransition) {
      return false;
    }
  }

  // Guard the right boundary
  const afterIndex = index + shorter.length;
  if (afterIndex < longer.length) {
    const charAfter = longer[afterIndex];
    const lastMatchChar = shorter[shorter.length - 1];
    const isLetterDigitTransition =
      isLetter(lastMatchChar) !== isLetter(charAfter);
    if (charAfter !== " " && charAfter !== "-" && !isLetterDigitTransition) {
      return false;
    }
  }

  return true;
}

// ─── Subject-switch classifier ────────────────────────────────────────────────

/**
 * Detect whether a comment switches subject to a different product despite
 * the identification step having extracted a `referenceModel` from the cheat
 * sheet. When this fires, the upstream `referenceProductId` should be cleared
 * so `ProductSearchAgent` doesn't inherit specs from a reference the comment
 * isn't actually about.
 *
 * Rule-based and intentionally conservative: only fires on strong cues that
 * are followed by a candidate product token. False negatives are tolerated
 * (the WI 4 pre-filter will catch many of them via category mismatch); false
 * positives are not — they would discard a legitimate variant resolution.
 *
 * Strong cues recognized:
 *   - "I (just) switched to/from <X>"
 *   - "instead (I) (got|bought|chose|picked|use) <X>"
 *   - "(now|but) I('m| am|'ve| have) (currently )?(using|on|got|bought) <X>"
 *
 * <X> must be at least one capitalized token followed by an alphanumeric token
 * (a typical brand+model pattern like "LG 27GR95"). Pure pronouns ("this",
 * "it", "mine") and bare nouns ("OLED panel") do not count.
 */
export function detectSubjectSwitch(commentBody: string): boolean {
  if (!commentBody) return false;

  // Pattern: a strong switch cue followed by a candidate product token.
  // The product-token guard requires:
  //   - a capitalized word (brand-like), then
  //   - optionally whitespace and an alnum-with-letters-and-digits token,
  //     OR a second capitalized word (e.g. "LG OLED" — but we still need at
  //     least one alnum/model-like token after).
  // The capture window between the cue and the product token is ≤40 chars to
  // avoid matching across unrelated clauses.

  // Two-step matching:
  //   1. Find a cue phrase (case-insensitive) and the position right after it.
  //   2. Verify a product-token pattern follows in the original body (case-sensitive).
  // Keeping the product-token check case-sensitive is essential — "OLED panel"
  // (panel lowercase) must NOT match the second token slot, which "OLED Panel"
  // (panel capitalized) would. The case-insensitive product-token version
  // would let "I prefer the OLED panel" register as a switch.

  // Cue: ends at a position from which the product token must follow.
  // Each cue tolerates an optional article ("the |a |an ") right before the token.
  const cuePatterns: RegExp[] = [
    /\bi\s+(?:just\s+)?switched\s+(?:to|from)\s+(?:the\s+|a\s+|an\s+)?/i,
    /\binstead\s+(?:of\s+|i\s+)?(?:got|bought|use|using|chose|picked)?\s*(?:the\s+|a\s+|an\s+)?/i,
    /(?:\bnow\b|\bbut\b)\s+i(?:'m|'ve|\s+am|\s+have)\s+(?:currently\s+)?(?:using|on|got|bought)\s+(?:the\s+|a\s+|an\s+)?/i,
    // "(now|but) I have <X>" — no follow-on verb required because the product
    // token already guards against bare nouns.
    /(?:\bnow\b|\bbut\b)\s+i\s+have\s+(?:the\s+|a\s+|an\s+)?/i,
    /\bi\s+(?:currently\s+)?(?:use|prefer)\s+(?:the\s+|a\s+|an\s+)?/i,
  ];

  // Product-token guard: a capitalized brand-like word followed by either
  // another capitalized word OR an alnum SKU-like token (≥3 chars, all
  // uppercase letters / digits / hyphens). Examples that match:
  //   "LG 27GR95B"      — capital brand + alnum SKU
  //   "Sony A95L"       — capital brand + alnum SKU
  //   "Samsung Odyssey" — capital brand + capital word
  // Examples that do NOT match (no second token, or second token is lowercase):
  //   "OLED panel"      — "panel" is lowercase
  //   "this monitor"    — "this" is lowercase
  //   "my old"          — "my" is lowercase
  const productTokenAtStart =
    /^(?:[A-Z][a-zA-Z0-9-]{1,}\s+(?:[A-Z][a-zA-Z0-9-]+|[A-Z0-9][A-Z0-9-]{2,}))\b/;

  for (const cue of cuePatterns) {
    const match = cue.exec(commentBody);
    if (!match) continue;
    const after = commentBody.slice(match.index + match[0].length);
    if (productTokenAtStart.test(after)) return true;
  }
  return false;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ResolutionInputEnricher {
  private readonly logger = new CustomLogger(ResolutionInputEnricher.name);

  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  /**
   * Enrich a product reference's resolution input with specs collected from:
   * 1. Descendant plan nodes by the **same author** that reference the same product
   * 2. Ancestor comments by the **same author** (any depth) that reference the same product
   * 3. Author's product affinity entries for the same product
   *
   * Same-author restriction on sources 1 and 2 prevents contamination from other
   * commenters in the reply tree who happen to own or test a different variant of the
   * product (e.g. another person replying "I have the 39"" in the same thread branch).
   *
   * Always runs regardless of whether the reference already has specs —
   * additional specs from context improve resolution accuracy.
   * Returns the original input unchanged when no new specs are found.
   */
  enrichInput(
    reference: ProductReference,
    comment: UserComment,
    ancestryIndex: AncestryIndex,
    allPlanNodes: SubtreeNode[],
    context: ThreadContext,
  ): ProductResolutionInput {
    const identification = reference.context.identification;
    const originalInput = referenceToResolutionInput(reference);

    // ── Anchor field resolution ──────────────────────────────────────────────
    // When identification emitted a referenceModel, resolve it to a referenceProductId
    // via the product registry so downstream routing (Path 0 / Path 1) can act on it.
    let referenceProductId: string | undefined;
    const { referenceModel, modelClues, variantClues } = identification;

    if (referenceModel) {
      // The cheat sheet renders catalog model as the bullet token, so referenceModel
      // is a catalog model string. The registry is keyed by brand::extractedModel,
      // so scan for an entry whose resolvedProduct.model matches, then fall back
      // to a direct key lookup for unresolved entries.
      const brandLower = (identification.brand ?? "").toLowerCase();
      const referenceModelLower = referenceModel.toLowerCase();
      // Exact key match first (fastest path, handles unresolved entries too)
      let registryEntry = context.productRegistry.get(
        `${brandLower}::${referenceModelLower}`,
      );
      let fuzzyMatchDistance: number | undefined;

      if (!registryEntry) {
        // Scan resolved entries for the brand and pick the one whose
        // resolvedProduct.model is closest to referenceModel by edit distance.
        // Handles cases where the LLM copies just the SKU code while the catalog
        // stores a family-name prefix (e.g. "Odyssey S34BG850SU" vs "S34BG850SU").
        let bestDistance = Infinity;
        for (const entry of context.productRegistry.values()) {
          if (entry.brand !== brandLower || !entry.resolvedProduct?.model)
            continue;
          const dist = levenshtein(
            entry.resolvedProduct.model.toLowerCase(),
            referenceModelLower,
          );
          if (dist < bestDistance) {
            bestDistance = dist;
            registryEntry = entry;
          }
        }
        if (registryEntry) fuzzyMatchDistance = bestDistance;
      }

      if (registryEntry?.resolvedProduct) {
        referenceProductId = registryEntry.resolvedProduct.id;
        if (fuzzyMatchDistance !== undefined) {
          this.logger.debug("referenceModel resolved via fuzzy match", {
            brand: identification.brand,
            referenceModel,
            matchedModel: registryEntry.resolvedProduct.model,
            editDistance: fuzzyMatchDistance,
            commentExternalId: comment.externalId,
          });
        }
      } else if (registryEntry) {
        this.logger.warn(
          "referenceModel resolves to unresolved cheat-sheet product",
          {
            brand: identification.brand,
            referenceModel,
            commentExternalId: comment.externalId,
          },
        );
      } else {
        this.logger.warn("referenceModel not found in product registry", {
          brand: identification.brand,
          referenceModel,
          commentExternalId: comment.externalId,
        });
      }
    }

    // ── Subject-switch classifier (WI 5) ─────────────────────────────────────
    // When the comment switches subject ("I switched to the LG 27GR95") despite
    // identification having tagged a referenceModel, drop the reference so
    // ProductSearchAgent doesn't inherit specs from a product the comment isn't
    // actually about. Rule-based and conservative — see `detectSubjectSwitch`.
    const subjectSwitchEnabled =
      this.dynamicConfig.enrichment?.subjectSwitchClassifierEnabled !== false;
    let referenceCleared = false;
    if (
      subjectSwitchEnabled &&
      (referenceProductId ||
        referenceModel ||
        (modelClues?.length ?? 0) > 0 ||
        (variantClues?.length ?? 0) > 0) &&
      detectSubjectSwitch(comment.body)
    ) {
      this.logger.debug(
        "Subject switch detected, clearing referenceProductId",
        {
          commentExternalId: comment.externalId,
          referenceModel,
          referenceProductId,
          modelClues,
        },
      );
      referenceProductId = undefined;
      referenceCleared = true;
    }

    const anchorFields: Pick<
      ProductResolutionInput,
      "referenceProductId" | "referenceModel" | "modelClues" | "variantClues"
    > = referenceCleared
      ? {
          referenceProductId: undefined,
          referenceModel: undefined,
          modelClues: undefined,
          variantClues: undefined,
        }
      : {
          referenceProductId,
          referenceModel,
          modelClues,
          variantClues,
        };

    // ── Spec enrichment ──────────────────────────────────────────────────────
    const ownSpecs = originalInput.specs ?? [];

    const enrichedSpecs = this.collectSpecs(
      comment,
      reference,
      ancestryIndex,
      allPlanNodes,
      context,
    );

    if (enrichedSpecs.length === 0) {
      if (
        referenceCleared ||
        referenceProductId ||
        referenceModel ||
        modelClues?.length ||
        variantClues?.length
      ) {
        return { ...originalInput, ...anchorFields };
      }
      return originalInput;
    }

    // Dedup by spec name: own specs take priority; skip enriched specs with duplicate names
    const normalizedOwn = new Set(ownSpecs.map((spec) => spec.name));
    const mergedSpecs = [...ownSpecs];

    for (const spec of enrichedSpecs) {
      if (!normalizedOwn.has(spec.name)) {
        normalizedOwn.add(spec.name);
        mergedSpecs.push(spec);
      }
    }

    if (mergedSpecs.length === ownSpecs.length) {
      if (
        referenceCleared ||
        referenceProductId ||
        referenceModel ||
        modelClues?.length ||
        variantClues?.length
      ) {
        return { ...originalInput, ...anchorFields };
      }
      return originalInput;
    }

    this.logger.debug("Enriched resolution input with context specs", {
      commentExternalId: comment.externalId,
      brand: originalInput.brand,
      model: originalInput.model,
      ownSpecs,
      enrichedSpecs,
      mergedSpecs,
    });

    return { ...originalInput, ...anchorFields, specs: mergedSpecs };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private collectSpecs(
    comment: UserComment,
    reference: ProductReference,
    ancestryIndex: AncestryIndex,
    allPlanNodes: SubtreeNode[],
    context: ThreadContext,
  ): StructuredSpec[] {
    const inputBrand = reference.context.identification?.brand;
    const inputModel = reference.context.identification?.model;
    const collected: StructuredSpec[] = [];

    // 1. Descendant plan nodes written by the same author that reference the same product.
    // Restricted to same-author to avoid picking up specs from other commenters who happen
    // to be replying in this branch (e.g. a different person saying "I have the 39"").
    const descendantIds = ancestryIndex.descendants.get(comment.externalId);
    if (descendantIds) {
      for (const descendantId of descendantIds) {
        const descendantNode = allPlanNodes.find(
          (node) => node.comment.externalId === descendantId,
        );
        if (!descendantNode) continue;
        if (descendantNode.comment.authorId !== comment.authorId) continue;

        for (const descendantRef of descendantNode.comment.productReferences ??
          []) {
          if (!descendantRef.enabled) continue;
          const refSpecs = descendantRef.context?.identification?.specs ?? [];
          if (refSpecs.length === 0) continue;

          if (
            isSameProduct(
              inputBrand,
              inputModel,
              descendantRef.context?.identification?.brand,
              descendantRef.context?.identification?.model,
            )
          ) {
            collected.push(...refSpecs);
          }
        }
      }
    }

    // 2. Ancestor comments written by the same author that reference the same product.
    // Restricted to same-author so that specs from other people's prior comments are not
    // attributed to this commenter's product.
    const ancestorIds = ancestryIndex.ancestors.get(comment.externalId);
    if (ancestorIds) {
      for (const ancestorId of ancestorIds) {
        const ancestorComment = context.getByExternalId(ancestorId);
        if (!ancestorComment) continue;
        if (ancestorComment.authorId !== comment.authorId) continue;

        for (const ancestorRef of ancestorComment.productReferences ?? []) {
          if (!ancestorRef.enabled) continue;
          const refSpecs = ancestorRef.context?.identification?.specs ?? [];
          if (refSpecs.length === 0) continue;

          if (
            isSameProduct(
              inputBrand,
              inputModel,
              ancestorRef.context?.identification?.brand,
              ancestorRef.context?.identification?.model,
            )
          ) {
            collected.push(...refSpecs);
          }
        }
      }
    }

    // 3. Author affinity entries for the same product: map OrderedSpec → StructuredSpec
    // OrderedSpec.key uses the same camelCase keys as validSpecs (e.g. "refreshRate")
    const affinityEntries = context.getAuthorAffinity(comment.authorId);
    for (const entry of affinityEntries) {
      const product = entry.product;
      if (
        !isSameProduct(
          inputBrand,
          inputModel,
          product.brand?.name,
          product.model,
        )
      )
        continue;

      for (const spec of product.orderedSpecs ?? []) {
        if (spec.value !== undefined && spec.value !== null) {
          collected.push({ name: spec.key, value: String(spec.value) });
        }
      }
    }

    return collected;
  }
}
