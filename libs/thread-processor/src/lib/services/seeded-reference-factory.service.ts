import { Injectable } from "@nestjs/common";
import {
  ContentQuality,
  ProductCategory,
  ProductReference,
  StructuredSpec,
  UserComment,
} from "@ebike-backend/database";
import {
  ResolutionResultApplierService,
  ResolutionRegistryUpdater,
} from "@ebike-backend/resolution";
import { HeldResolution } from "../models/discovered-product.model";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Normalised per-product input the factory turns into a `ProductReference`. The
 * coordinator builds one of these per (comment, product) from either a
 * discovered+resolved distinct product or a NEW product surfaced by
 * identification — so the factory is agnostic to which path produced it.
 *
 * `specs` MUST already be whitelist-filtered (valid spec names only) — the
 * factory does not re-filter.
 */
export interface ReferenceSeed {
  type: "explicit" | "referenced";
  brand: string;
  model: string;
  /** Whitelist-filtered specs. */
  specs: StructuredSpec[];
  categoryHint?: string;
  referenceModel?: string;
  modelClues?: string[];
  variantClues?: string[];
  contentQuality: ContentQuality;
  /** Minted/inherited same-product group UUID. */
  productLinkId: string;
  /** Raw same-product group letter (trace/audit). */
  productLinkLabel?: string;
  /** Fuzzy registry key for this product. */
  registryKey: string;
  /** Matched catalog category (enabled match preferred; may be a disabled
   *  category → the ref defers). Undefined when no category matched. */
  productCategory?: ProductCategory;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Builds `ProductReference` entities for pass 1 and seeds them "born resolved".
 *
 * Construction (`buildReference`) reproduces the full `context.identification`
 * shape every downstream consumer reads — the load-bearing preserve-list. The
 * born-resolved seam (`seedResolution`) routes a held `ResolutionResult` through
 * the SAME `ResolutionResultApplierService.apply()` the normal resolver uses, so
 * a seeded ref is indistinguishable from a normally-resolved one (full
 * multi-candidate set, `ambiguousResolution`, `searchContext`).
 *
 * Save ordering is owned by the coordinator: build → saveAll (assign ids) →
 * seedResolution (writes candidate rows, FK → ref.id) → saveAll.
 */
@Injectable()
export class SeededReferenceFactory {
  constructor(
    private readonly resolutionApplier: ResolutionResultApplierService,
  ) {}

  /**
   * Build an UNSAVED reference for one product on a comment. `candidates` is left
   * `[]` and `resolutionFinished` `false`; the coordinator saves the ref (to
   * assign an id) before {@link seedResolution} writes candidates.
   */
  buildReference(comment: UserComment, seed: ReferenceSeed): ProductReference {
    const reference = new ProductReference();
    reference.comment = comment;
    reference.context = {
      identification: {
        type: seed.type,
        brand: seed.brand,
        model: seed.model,
        displayName: `${seed.brand} ${seed.model}`.trim(),
        searchBefore: comment.externalCreationTs,
        specs: seed.specs,
        categories: seed.categoryHint ? [seed.categoryHint] : [],
        registryKey: seed.registryKey,
        contentQuality: seed.contentQuality,
        categoryHint: seed.categoryHint,
        referenceModel: seed.referenceModel,
        modelClues: seed.modelClues,
        variantClues: seed.variantClues,
        productLinkLabel: seed.productLinkLabel,
      },
      resolution: {},
    };
    reference.productCategory = seed.productCategory ?? undefined;
    reference.categoryHint = seed.categoryHint ?? undefined;
    reference.productLinkId = seed.productLinkId;
    reference.resolutionFinished = false;
    reference.resolutionAttemptCount = 0;
    reference.attemptResolutionAfter = null;
    reference.relevance = 0;
    reference.enabled = true;
    reference.flagged = false;
    reference.candidates = [];
    reference.ambiguousResolution = false;
    reference.reviewComment = undefined;
    // Extraction fields left empty — populated during pass 2.
    reference.quotes = [];
    reference.sentiment = undefined;
    reference.experience = undefined;
    reference.depth = undefined;
    reference.intents = undefined;
    reference.useCases = null;
    reference.specs = seed.specs.length > 0 ? seed.specs : undefined;
    reference.features = null;

    return reference;
  }

  /**
   * Seed a SAVED reference with its held resolution. Routes the full
   * `ResolutionResult` through `apply()` (which builds the complete candidate
   * set + `ambiguousResolution` and syncs the registry), after assigning a
   * per-ref CLONE of the resolution context to `searchContext` (siblings sharing
   * one held result must not alias the same context object).
   *
   * No-ops for a deferred product (`held.result === null`) — the ref stays
   * unresolved (`resolutionFinished` left false) for Resolution Backfill.
   */
  async seedResolution(
    reference: ProductReference,
    held: HeldResolution,
    commentBody: string,
    registryUpdater: ResolutionRegistryUpdater,
  ): Promise<void> {
    if (!held.result) return;

    // Per-ref clone: N comments mapping to one distinct product share a single
    // held result; without cloning, a later in-place mutation of searchContext
    // (spec append, detector reads) would corrupt every sibling.
    reference.searchContext = structuredClone(held.result.context);

    await this.resolutionApplier.apply(reference, held.result, {
      commentBody,
      registry: registryUpdater,
    });

    reference.resolutionFinished = true;
    reference.resolutionLastAttemptedAt = new Date();
  }
}
