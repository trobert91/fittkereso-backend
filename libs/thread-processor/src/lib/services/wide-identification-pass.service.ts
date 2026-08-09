import { Injectable } from "@nestjs/common";
import {
  CommentStatus,
  ProductReference,
  ProductReferenceRepository,
  Thread,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { DebugTraceService } from "@ebike-backend/debug";
import { PipelineMetricsService } from "@ebike-backend/metrics";
import { compact, isEmpty } from "lodash";
import { Subtree } from "../models/subtree.model";
import { ThreadContext } from "../models/thread-context";
import { RegistryOptions } from "../models/product-registry.model";
import {
  DiscoveredProduct,
  EnrichedDiscoveredProduct,
  HeldResolution,
} from "../models/discovered-product.model";
import { LLMMappedProductRef } from "../schemas/comment-identification.schema";
import { LLMMappedProduct } from "../schemas/subtree-identification.schema";
import {
  DiscoveryPhaseConfig,
  IdentificationPhaseConfig,
} from "@ebike-backend/config";
import { ProductDiscoveryService } from "./product-discovery.service";
import { CommentIdentificationService } from "./comment-identification.service";
import { DiscoveredProductEnricher } from "./discovered-product-enricher.service";
import { DistinctProductResolver } from "./distinct-product-resolver.service";
import {
  ReferenceSeed,
  SeededReferenceFactory,
} from "./seeded-reference-factory.service";
import { ProductRegistryService } from "./product-registry.service";
import { ResolvedDiscoveredProduct } from "./prompt-assembly.service";
import { appendSystemModeration } from "../utils/system-moderation.util";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WideIdentificationConfig {
  threadId: string;
  discovery: DiscoveryPhaseConfig;
  identification: IdentificationPhaseConfig;
  validSpecNames: Set<string>;
  registryOpts: RegistryOptions;
}

export interface WideIdentificationResult {
  /** Per-comment annotations rebuilt from the created refs, for the pass-2
   *  extraction prompt (comment id → product list). */
  planProductAnnotations: Map<string, LLMMappedProduct[]>;
  /** Count of product mentions identified across the subtree. */
  mentionsIdentified: number;
}

/** A product a comment maps to, paired with its held resolution and seed. */
interface MappedSeed {
  seed: ReferenceSeed;
  held: HeldResolution;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Pass-1 coordinator. Per wide subtree, sequences the small collaborators:
 * discovery → enrich → resolve distinct → identify → seed born-resolved
 * references → SKIPPED demotion. Owns ONLY sequencing + the save ordering the
 * born-resolved seam requires (build → saveAll → seedResolution → saveAll);
 * every unit of real work lives in an injected service.
 */
@Injectable()
export class WideIdentificationPassService {
  private readonly logger = new CustomLogger(
    WideIdentificationPassService.name,
  );

  constructor(
    private readonly discovery: ProductDiscoveryService,
    private readonly enricher: DiscoveredProductEnricher,
    private readonly distinctResolver: DistinctProductResolver,
    private readonly commentIdentification: CommentIdentificationService,
    private readonly referenceFactory: SeededReferenceFactory,
    private readonly productRegistry: ProductRegistryService,
    private readonly commentRepository: UserCommentRepository,
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly debugTrace: DebugTraceService,
    private readonly pipelineMetrics: PipelineMetricsService,
  ) {}

  async run(
    subtree: Subtree,
    thread: Thread,
    context: ThreadContext,
    config: WideIdentificationConfig,
  ): Promise<WideIdentificationResult> {
    if (isEmpty(subtree.planNodes)) {
      return { planProductAnnotations: new Map(), mentionsIdentified: 0 };
    }

    // 1. Discovery (LLM) — distinct products with pooled evidence.
    const discoveryStart = Date.now();
    const discovery = await this.discovery.discover(subtree, context, {
      threadId: config.threadId,
      model: config.discovery.model,
      thinking: config.discovery.thinking,
      effort: config.discovery.effort,
    });
    if (discovery.traceCall) {
      await this.recordTrace(thread.id, subtree, "product_discovery", {
        model: discovery.traceCall.model,
        systemPrompt: discovery.traceCall.systemPrompt,
        userPrompt: discovery.traceCall.userPrompt,
        response: discovery.traceCall.rawResponse,
        cost: discovery.traceCall.cost,
        durationMs: discovery.traceCall.durationMs,
      });
    }
    this.recordPhaseDuration("product_discovery", discoveryStart);

    // 2. Enrich — category, registry key, productLinkId, resolution input.
    // searchBefore = earliest mention available to this batch (its earliest PLAN
    // comment); a discovered product's first occurrence can't precede it, so it
    // bounds the resolve-time web search. Per-ref searchBefore is set per-mention
    // later by the reference factory.
    const batchSearchBefore = this.earliestPlanTimestamp(subtree);
    const enriched = await this.enricher.enrich(
      discovery.products,
      context,
      config.validSpecNames,
      batchSearchBefore,
    );
    const enrichedByKey = new Map(enriched.map((e) => [e.distinctKey, e]));

    // 3. Resolve distinct products once each.
    const resolutionStart = Date.now();
    const heldByKey = await this.distinctResolver.resolveDistinctProducts(
      enriched,
      thread,
      context,
      subtree.isOpSubtree,
    );
    this.recordPhaseDuration("product_resolution", resolutionStart);

    // 4. Comment identification (LLM) — map comments to the resolved set.
    const identifyStart = Date.now();
    const resolvedForPrompt: ResolvedDiscoveredProduct[] = enriched.map(
      (e) => ({
        enriched: e,
        heldResolution: heldByKey.get(e.distinctKey) ?? {
          result: null,
          resolved: false,
        },
      }),
    );
    const identification = await this.commentIdentification.identify(
      subtree,
      context,
      resolvedForPrompt,
      {
        threadId: config.threadId,
        model: config.identification.model,
        thinking: config.identification.thinking,
        effort: config.identification.effort,
        missRateRetryThreshold: config.identification.missRateRetryThreshold,
      },
    );
    if (identification.traceCall) {
      await this.recordTrace(thread.id, subtree, "comment_identification", {
        model: identification.traceCall.model,
        systemPrompt: identification.traceCall.systemPrompt,
        userPrompt: identification.traceCall.userPrompt,
        response: identification.traceCall.rawResponse,
        cost: identification.traceCall.cost,
        durationMs: identification.traceCall.durationMs,
      });
    }
    this.recordPhaseDuration("comment_identification", identifyStart);

    // 5. Seed references per comment (born resolved), with SKIPPED demotion.
    const seedStart = Date.now();
    const mentionsIdentified = await this.seedReferences(
      subtree,
      thread,
      context,
      enrichedByKey,
      heldByKey,
      identification.productMap,
      config,
    );
    this.recordPhaseDuration("reference_creation", seedStart);

    // 6. Grow the incremental cheat sheet so the NEXT subtree's discovery sees
    //    this subtree's products. Mirrors the old Phase 3b registry update:
    //    resolved entries were synced per seeded ref by the applier; this adds
    //    mention-side data + deferred placeholders, then re-renders.
    this.updateRegistry(subtree, context, config.registryOpts);

    return {
      planProductAnnotations: this.buildPlanProductAnnotations(subtree),
      mentionsIdentified,
    };
  }

  // ─── Reference seeding ─────────────────────────────────────────────────────

  private async seedReferences(
    subtree: Subtree,
    thread: Thread,
    context: ThreadContext,
    enrichedByKey: Map<string, EnrichedDiscoveredProduct>,
    heldByKey: Map<string, HeldResolution>,
    productMap: Map<string, LLMMappedProductRef[]>,
    config: WideIdentificationConfig,
  ): Promise<number> {
    let mentionsIdentified = 0;
    const registryUpdater = this.productRegistry.createUpdaterFor(context);

    for (const node of subtree.planNodes) {
      const comment = node.comment;
      const mapped = productMap.get(comment.id) ?? [];

      // SKIPPED demotion (OP comments are never demoted):
      //   - absent from the map OR no products → SKIPPED (no buyer-relevant ref)
      //   - all products low quality → SKIPPED
      if (
        !subtree.isOpSubtree &&
        this.shouldSkip(comment, mapped, productMap)
      ) {
        await this.demote(comment, mapped, productMap);
        continue;
      }

      // Resolve each mapped product to a seed + held resolution (known by
      // linkLabel, or a NEW product resolved inline).
      const seeds = await this.buildSeedsForComment(
        comment,
        mapped,
        thread,
        context,
        enrichedByKey,
        heldByKey,
        config,
        subtree.isOpSubtree,
      );

      // Clear stale refs (leftovers from a prior run this re-identification
      // replaces) before creating fresh ones.
      await this.deleteStaleRefs(comment);

      const refs = seeds.map(({ seed }) =>
        this.referenceFactory.buildReference(comment, seed),
      );
      // Save FIRST so candidate FKs resolve (candidates still []).
      if (refs.length > 0) {
        await this.productReferenceRepository.saveAll(refs);
      }
      // Then seed each ref's resolution and save again.
      for (let i = 0; i < refs.length; i++) {
        await this.referenceFactory.seedResolution(
          refs[i],
          seeds[i].held,
          comment.body,
          registryUpdater,
        );
      }
      if (refs.length > 0) {
        await this.productReferenceRepository.saveAll(refs);
      }

      comment.productReferences = refs;
      comment.status = CommentStatus.IDENTIFIED;
      await this.commentRepository.save(comment);
      context.addComment(comment);
      mentionsIdentified += refs.length;
    }

    return mentionsIdentified;
  }

  /** Build a seed + held resolution for each product a comment references. */
  private async buildSeedsForComment(
    comment: UserComment,
    mapped: LLMMappedProductRef[],
    thread: Thread,
    context: ThreadContext,
    enrichedByKey: Map<string, EnrichedDiscoveredProduct>,
    heldByKey: Map<string, HeldResolution>,
    config: WideIdentificationConfig,
    isOpSubtree: boolean,
  ): Promise<MappedSeed[]> {
    const result: MappedSeed[] = [];

    for (const product of mapped) {
      const knownEnriched = product.linkLabel
        ? enrichedByKey.get(product.linkLabel)
        : undefined;
      if (product.linkLabel && knownEnriched) {
        // Known product — seed from the discovered+resolved bundle.
        const held = heldByKey.get(product.linkLabel) ?? {
          result: null,
          resolved: false,
        };
        result.push({
          seed: this.seedFromEnriched(knownEnriched, product, isOpSubtree),
          held,
        });
      } else if (product.new) {
        // NEW product discovery missed — enrich + resolve it inline. Its
        // resolved registry entry is synced when its ref is seeded (applier);
        // mention-side data + cheat-sheet render happen in updateRegistry.
        // The surfacing comment IS the mention → its timestamp is searchBefore.
        const enriched = await this.enrichNewProduct(
          product.new,
          product.contentQuality,
          context,
          config,
          comment.externalCreationTs,
        );
        const held = await this.distinctResolver.resolveProduct(
          enriched,
          thread,
          context,
          isOpSubtree,
        );
        result.push({
          seed: this.seedFromEnriched(enriched, product, isOpSubtree),
          held,
        });
      }
      // A product entry with neither a known linkLabel nor a new block is
      // dropped — nothing to resolve.
    }

    return result;
  }

  /** Build a `ReferenceSeed` from an enriched distinct product, taking the
   *  per-comment `type`/`contentQuality` from the identification mapping and the
   *  OP content-quality override. OP comments always get `high` quality —
   *  guaranteeing web search and preventing demotion — regardless of how
   *  substantively the OP itself evaluates the product. */
  private seedFromEnriched(
    enriched: EnrichedDiscoveredProduct,
    product: LLMMappedProductRef,
    isOpSubtree: boolean,
  ): ReferenceSeed {
    return {
      type: product.type,
      brand: enriched.discovered.brand,
      model: enriched.discovered.model,
      specs: enriched.filteredSpecs,
      categoryHint: enriched.discovered.categoryHint,
      referenceModel: enriched.discovered.referenceModel,
      modelClues: enriched.discovered.modelClues,
      variantClues: enriched.discovered.variantClues,
      contentQuality: isOpSubtree ? "high" : product.contentQuality,
      productLinkId: enriched.productLinkId,
      productLinkLabel: enriched.discovered.linkLabel,
      registryKey: enriched.registryKey,
      productCategory: enriched.productCategory,
    };
  }

  /** Enrich a single NEW product from the identification `new` block. */
  private async enrichNewProduct(
    newProduct: NonNullable<LLMMappedProductRef["new"]>,
    contentQuality: DiscoveredProduct["contentQuality"],
    context: ThreadContext,
    config: WideIdentificationConfig,
    searchBefore: Date | undefined,
  ): Promise<EnrichedDiscoveredProduct> {
    const discovered: DiscoveredProduct = {
      brand: newProduct.brand,
      model: newProduct.model,
      categoryHint: newProduct.categoryHint,
      specs: newProduct.specs,
      modelClues: newProduct.modelClues,
      variantClues: newProduct.variantClues,
      contentQuality,
      // A distinct key not colliding with discovery letters.
      linkLabel: `new:${newProduct.brand}:${newProduct.model}`.toLowerCase(),
    };
    const [enriched] = await this.enricher.enrich(
      [discovered],
      context,
      config.validSpecNames,
      searchBefore,
    );
    return enriched;
  }

  // ─── SKIPPED demotion ──────────────────────────────────────────────────────

  private shouldSkip(
    comment: UserComment,
    mapped: LLMMappedProductRef[],
    productMap: Map<string, LLMMappedProductRef[]>,
  ): boolean {
    if (!productMap.has(comment.id)) return true;
    if (isEmpty(mapped)) return true;
    if (mapped.every((product) => product.contentQuality === "low"))
      return true;
    return false;
  }

  private async demote(
    comment: UserComment,
    mapped: LLMMappedProductRef[],
    productMap: Map<string, LLMMappedProductRef[]>,
  ): Promise<void> {
    comment.status = CommentStatus.SKIPPED;
    if (!productMap.has(comment.id)) {
      comment.relevance = 0;
      appendSystemModeration(
        comment,
        "No buyer-relevant product references identified",
        CommentStatus.SKIPPED,
      );
    } else if (isEmpty(mapped)) {
      appendSystemModeration(
        comment,
        "No product references — extraction skipped",
        CommentStatus.SKIPPED,
      );
    } else {
      appendSystemModeration(
        comment,
        "Only low-quality product references — extraction skipped",
        CommentStatus.SKIPPED,
      );
    }
    await this.commentRepository.save(comment);
  }

  // ─── Registry + annotations ────────────────────────────────────────────────

  /**
   * Grow the incremental registry + cheat sheet from this subtree's seeded
   * references, then re-render so the next subtree's discovery sees these
   * products. Resolved entries were synced per ref by the applier during
   * seeding; this adds mention-side data (referenceCount/recency/mentionedAs)
   * and deferred placeholders, mirroring the old Phase 3b update.
   *
   * Recency: age every entry first (`shiftRecencyFlags`), then upsert — so a
   * product MENTIONED in this subtree is bumped back to `latest` (new entries
   * land `latest`; re-mentioned ones are refreshed), while a product NOT
   * mentioned here ages one tier. This keeps pass-1 recency consistent with
   * pass-2's `updateRegistry`: mentioned → latest, regardless of subtree.
   */
  private updateRegistry(
    subtree: Subtree,
    context: ThreadContext,
    registryOpts: RegistryOptions,
  ): void {
    const refs = subtree.planNodes.flatMap(
      (node) => node.comment.productReferences ?? [],
    );
    // Shift BEFORE upsert so products mentioned in this subtree land/refresh as
    // `latest` and unmentioned ones age.
    this.productRegistry.shiftRecencyFlags(context);
    // Deferred (disabled-category) refs aren't resolved, so seed them as
    // cheat-sheet placeholders by name.
    for (const ref of refs) {
      if ((ref.candidates?.length ?? 0) === 0) {
        this.productRegistry.registerDeferredReference(ref, context);
      }
    }
    this.productRegistry.upsertFromResolution(
      refs,
      subtree.isOpSubtree,
      context,
    );
    this.productRegistry.renderCheatSheet(context, registryOpts);
  }

  /** Rebuild per-comment extraction annotations from the created references. */
  private buildPlanProductAnnotations(
    subtree: Subtree,
  ): Map<string, LLMMappedProduct[]> {
    const annotations = new Map<string, LLMMappedProduct[]>();
    for (const node of subtree.planNodes) {
      const refs = node.comment.productReferences ?? [];
      if (refs.length === 0) continue;
      const products = compact(refs.map((ref) => this.refToAnnotation(ref)));
      if (products.length > 0) annotations.set(node.comment.id, products);
    }
    return annotations;
  }

  private refToAnnotation(ref: ProductReference): LLMMappedProduct | null {
    const identification = ref.context?.identification;
    if (!identification) return null;
    return {
      type: identification.type ?? "explicit",
      brand: identification.brand ?? "",
      model: identification.model ?? "",
      contentQuality: identification.contentQuality ?? "medium",
      linkId: identification.productLinkLabel ?? "",
      ...(identification.categoryHint && {
        categoryHint: identification.categoryHint,
      }),
      ...(identification.specs && { specs: identification.specs }),
      ...(identification.referenceModel && {
        referenceModel: identification.referenceModel,
      }),
      ...(identification.modelClues && {
        modelClues: identification.modelClues,
      }),
      ...(identification.variantClues && {
        variantClues: identification.variantClues,
      }),
    };
  }

  // ─── Trace + metrics ───────────────────────────────────────────────────────

  private async deleteStaleRefs(comment: UserComment): Promise<void> {
    const staleRefs = comment.productReferences ?? [];
    if (staleRefs.length > 0) {
      await this.productReferenceRepository.repo.delete(
        staleRefs.map((ref) => ref.id),
      );
    }
  }

  private async recordTrace(
    threadId: string,
    subtree: Subtree,
    step: string,
    data: {
      model: string;
      systemPrompt: string;
      userPrompt: string;
      response: string;
      cost: number;
      durationMs: number;
    },
  ): Promise<void> {
    try {
      const llm = {
        systemPrompt: data.systemPrompt,
        userPrompt: data.userPrompt,
        rawResponse: data.response,
        temperature: 1,
      };
      const summary = `${step} [${data.model}] on subtree ${subtree.id}`;
      await this.debugTrace.record({
        threadId,
        step,
        statusBefore: "new",
        statusAfter: "identified",
        durationMs: data.durationMs,
        cost: data.cost,
        data:
          step === "product_discovery"
            ? { summary, discovery: {}, llm }
            : { summary, commentIdentification: {}, llm },
      });
    } catch (error) {
      this.logger.warn("Failed to record pass-1 trace", { step, error });
    }
  }

  private recordPhaseDuration(phase: string, startMs: number): void {
    this.pipelineMetrics.recordThreadPhaseDuration(
      phase,
      (Date.now() - startMs) / 1000,
    );
  }

  /** Earliest `externalCreationTs` among the subtree's PLAN comments — the
   *  first-occurrence lower bound for any product discovery surfaced from this
   *  batch. Undefined when no PLAN comment carries a timestamp. */
  private earliestPlanTimestamp(subtree: Subtree): Date | undefined {
    let earliest: Date | undefined;
    for (const node of subtree.planNodes) {
      const ts = node.comment.externalCreationTs;
      if (ts && (!earliest || ts < earliest)) earliest = ts;
    }
    return earliest;
  }
}
