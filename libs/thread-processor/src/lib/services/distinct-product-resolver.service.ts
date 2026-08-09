import { Injectable } from "@nestjs/common";
import { Thread } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { ChatTraceData } from "@ebike-backend/debug";
import {
  ResolutionService,
  ResolutionOptions,
  ResolutionThreadContext,
} from "@ebike-backend/resolution";
import { ThreadContext } from "../models/thread-context";
import {
  EnrichedDiscoveredProduct,
  HeldResolution,
} from "../models/discovered-product.model";
import { buildRegistryHitResult } from "./registry-hit-result";

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Pass-1 `product_resolution` step. Resolves each DISTINCT discovered product
 * exactly once — directly, with the evidence discovery already pooled — and
 * holds the FULL `ResolutionResult` per product so per-comment reference seeding
 * can reproduce it. Because discovery is product-centric (already deduped +
 * pooled), there is no within-batch pooling / primary-election / fixpoint here:
 * one product, one resolution.
 *
 * Outputs a `Map` keyed by each product's `distinctKey`. A product whose
 * category is disabled resolves to `{ result: null, resolved: false }` — its
 * reference is still created and registered, and the scheduled Resolution
 * Backfill resolves it later.
 */
@Injectable()
export class DistinctProductResolver {
  private readonly logger = new CustomLogger(DistinctProductResolver.name);

  constructor(private readonly productSearch: ResolutionService) {}

  async resolveDistinctProducts(
    products: EnrichedDiscoveredProduct[],
    thread: Thread,
    context: ThreadContext,
    isOpSubtree: boolean,
  ): Promise<Map<string, HeldResolution>> {
    const threadContext = this.buildResolutionThreadContext(thread, context);
    const held = new Map<string, HeldResolution>();

    for (const product of products) {
      held.set(
        product.distinctKey,
        await this.resolveOne(
          product,
          thread,
          context,
          threadContext,
          isOpSubtree,
        ),
      );
    }

    return held;
  }

  /** Resolve a single product the same way a fresh per-ref resolve would, used
   *  inline by the coordinator for a NEW product the discovery sweep missed. */
  async resolveProduct(
    product: EnrichedDiscoveredProduct,
    thread: Thread,
    context: ThreadContext,
    isOpSubtree: boolean,
  ): Promise<HeldResolution> {
    const threadContext = this.buildResolutionThreadContext(thread, context);
    return this.resolveOne(
      product,
      thread,
      context,
      threadContext,
      isOpSubtree,
    );
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private async resolveOne(
    product: EnrichedDiscoveredProduct,
    thread: Thread,
    context: ThreadContext,
    threadContext: ResolutionThreadContext,
    isOpSubtree: boolean,
  ): Promise<HeldResolution> {
    // Disabled category → deferred. The ref is created + registered; Resolution
    // Backfill resolves it once the category is enabled.
    if (!this.isProductResolvable(product)) {
      return { result: null, resolved: false };
    }

    // Registry hit: this product already resolved in an earlier subtree this
    // run — synthesize the result from the registry entry instead of searching.
    // Carry the entry's full candidate set so an ambiguous prior resolution
    // propagates its runners-up (not just the primary) onto the new refs.
    const entry = context.productRegistry.get(product.registryKey);
    if (entry?.resolvedProduct) {
      return {
        result: buildRegistryHitResult(
          product.resolutionInput,
          entry.resolvedProduct,
          entry.candidateSet,
        ),
        resolved: true,
      };
    }

    // Cost-controlled web search: OP always; otherwise only substantive
    // (high-quality) products warrant the SERP spend.
    const allowWebSearch =
      isOpSubtree || product.discovered.contentQuality === "high";

    const options: ResolutionOptions = {
      useEmbedding: true,
      webSearchEnabled: allowWebSearch,
      mode: "loose",
    };

    const result = await this.productSearch.search(
      product.resolutionInput,
      options,
      { threadId: thread.id, threadContext },
      (_data: ChatTraceData) => {
        // Web-search LLM cost is captured by the lib's own trace accounting via
        // threadId; no per-call aggregation needed here.
      },
      { threadId: thread.id },
    );

    this.logger.debug("Distinct product resolved", {
      threadId: thread.id,
      distinctKey: product.distinctKey,
      resolved: result.resolvedModel != null,
      candidates: result.context.decision?.selectedCandidates?.length ?? 0,
    });

    return { result, resolved: result.resolvedModel != null };
  }

  /** Build the thread-scoped resolution context (resolved product names for
   *  disambiguation), mirroring the orchestrator's per-subtree context. */
  private buildResolutionThreadContext(
    thread: Thread,
    context: ThreadContext,
  ): ResolutionThreadContext {
    const resolvedProducts = [...context.productRegistry.values()]
      .filter((entry) => entry.resolvedProduct)
      .map((entry) => entry.displayName);

    return {
      threadTitle: thread.title,
      subreddit: thread.topic,
      opSummary: context.opSection ?? undefined,
      resolvedProducts:
        resolvedProducts.length > 0 ? resolvedProducts : undefined,
    };
  }

  /** A discovered product is resolvable unless its matched category is disabled
   *  — the reference-level equivalent is `isCategoryResolvable`. */
  private isProductResolvable(product: EnrichedDiscoveredProduct): boolean {
    const category = product.productCategory;
    return !category || category.extractionEnabled === true;
  }
}
