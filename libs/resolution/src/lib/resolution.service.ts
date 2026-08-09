import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import type { ChatTraceData } from "@ebike-backend/debug";
import type { CallerContext } from "./models/caller-context";
import type { ResolutionContext } from "./models/resolution-context";
import type { ProductResolutionInput } from "./models/resolution-input";
import type { ResolutionOptions } from "./models/resolution-options";
import type { ResolutionResult } from "./models/resolution-result";
import { ResolutionStatus } from "./models/resolution-status";
import { ReferenceProductResolver } from "./stages/reference-product-resolver";
import { BrandResolverService } from "./stages/brand-resolver.service";
import { CategoryResolverService } from "./stages/category-resolver.service";
import { RecallService } from "./stages/recall.service";
import { FilterService } from "./stages/filter.service";
import { ScoringService } from "./stages/scoring.service";
import { DecisionService } from "./stages/decision.service";
import { FinalizeService } from "./stages/finalize.service";
import { productSpecsSummary } from "./matching/spec-utils";
import type { SlimResolvedModel } from "./models/slim-types";

/**
 * Safety net for the recall fixed-point loop. Correct strategies converge
 * naturally — under the current three strategies (fuzzy, embedding, web), all
 * single-shot, the loop runs at most 4 iterations (one per strategy + the
 * convergence iteration). The cap exists to fail fast if a future N-shot
 * strategy's `shouldRun` doesn't converge to false.
 */
const MAX_RECALL_ITERATIONS = 10;

/**
 * Public entry point for product resolution.
 *
 * Single-pass orchestration over the registered stages:
 *
 *   [1] Reference-product resolver — UUID → entity → classify (same/variant/none).
 *       'same' short-circuits with confidence=100; 'variant' or null falls
 *       through to the rest of the pipeline.
 *   [2] Brand + category resolution — skipped when stage 1 already populated.
 *   [3] Recall — fan out RecallStrategy[] (fuzzy, embedding, web).
 *   [4] Filter — category gate + effectiveMatchSpecs gate.
 *   [5] Score — matcher + quality gates → ctx.scoring.
 *   [6] Decide — matcher_accept short-circuit OR DecisionStrategy (LLM).
 *   [7] Finalize — alias auto-create + build result.
 *
 * No loops; each stage is a pure function over the running `ResolutionContext`.
 */
@Injectable()
export class ResolutionService {
  private readonly logger = new CustomLogger(ResolutionService.name);

  constructor(
    private readonly referenceResolver: ReferenceProductResolver,
    private readonly brandResolver: BrandResolverService,
    private readonly categoryResolver: CategoryResolverService,
    private readonly recallService: RecallService,
    private readonly filterService: FilterService,
    private readonly scoringService: ScoringService,
    private readonly decisionService: DecisionService,
    private readonly finalizeService: FinalizeService,
  ) {}

  async search(
    input: ProductResolutionInput,
    options: ResolutionOptions,
    callerContext: CallerContext = {},
    traceCollector?: (data: ChatTraceData) => void,
    logContext?: Record<string, string>,
  ): Promise<ResolutionResult> {
    const startedAt = Date.now();
    const context = createInitialContext(input, options);
    context.threadId = callerContext.threadId;

    // ── Stage 1 — reference-product resolver ────────────────────────────────
    const referenceResult = await this.referenceResolver.resolve(context);

    if (referenceResult?.kind === "resolved") {
      // Short-circuit: input names the same product as the reference.
      const product = referenceResult.product;
      context.decision = {
        kind: "matcher_accept",
        confidence: referenceResult.confidence,
        reason: referenceResult.reason,
        selectedCandidates: [
          {
            candidateId: product.id,
            confidence: referenceResult.confidence,
            reason: referenceResult.reason,
          },
        ],
        evidenceSummary: "reference product matched directly (relation=same)",
      };
      context.resolvedProduct = toSlimResolved(product);
      context.status = ResolutionStatus.RESOLVED;
      context.totals.durationMs = Date.now() - startedAt;
      this.logResolutionSummary(context, logContext);
      return {
        resolvedModel: product,
        context,
        confidence: referenceResult.confidence,
      };
    }

    // ── Stage 2 — brand + category (skipped when stage 1 populated them) ────
    await Promise.all([
      this.brandResolver.resolve(context),
      this.categoryResolver.resolve(context),
    ]);

    // ── Stages 3–5 — recall, filter, score; loop until recall converges ─────
    // Each strategy self-gates on `context` (most importantly `strategiesRun`,
    // which records every prior fire). The loop ends when an entire recall
    // pass produces no new strategy invocations — the candidate pool can't be
    // widened further and we proceed to decide. Each iteration is recall →
    // filter → score so the next iteration's `shouldRun` predicates see fresh
    // scoring (e.g. embedding's rescue trigger reads `scoring.failedGates`).
    //
    // MAX_RECALL_ITERATIONS is a safety net for a misbehaving strategy whose
    // `shouldRun` never converges to false; under correct strategies the loop
    // exits as soon as the convergence iteration runs.
    for (let iteration = 0; iteration < MAX_RECALL_ITERATIONS; iteration++) {
      const strategiesBefore = context.strategiesRun.length;
      await this.recallService.recall(context);
      if (context.strategiesRun.length === strategiesBefore) break;

      const filterResult = this.filterService.filter(context);
      context.candidates = filterResult.qualifyingCandidates;
      context.filter = filterResult.outcome;
      this.scoringService.score(context);

      if (iteration === MAX_RECALL_ITERATIONS - 1) {
        context.errors.push({
          phase: "recall",
          message: `recall loop hit max iterations (${MAX_RECALL_ITERATIONS}) without converging`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ── Stage 6 — decide ────────────────────────────────────────────────────
    await this.decisionService.decide(
      context,
      callerContext.threadContext,
      traceCollector,
      logContext,
    );

    // ── Stage 7 — finalize ──────────────────────────────────────────────────
    const result = await this.finalizeService.finalize(context);

    context.totals.durationMs = Date.now() - startedAt;
    this.logResolutionSummary(context, logContext);
    return result;
  }

  /**
   * One end-of-resolution summary log per call. Renders every load-bearing
   * decision-making field from the persisted context so a single line in Loki
   * carries the full picture: input, resolved brand/category, reference
   * product, recall funnel, filter rejections, scoring snapshot, decision
   * outcome, and errors. Replaces all the per-stage `logger.debug/.warn` calls
   * we used to emit mid-flight.
   *
   * Level: `info` on RESOLVED, `warn` on UNRESOLVED, so dashboards and ad-hoc
   * Loki queries can split happy-path from problematic resolutions without
   * parsing the JSON payload.
   */
  private logResolutionSummary(
    context: ResolutionContext,
    logContext?: Record<string, string>,
  ): void {
    const summary = {
      status: context.status,
      input: {
        brand: context.input.brand,
        model: context.input.model,
        displayName: context.input.displayName,
        referenceProductId: context.input.referenceProductId,
        referenceModel: context.input.referenceModel,
        modelClues: context.input.modelClues,
        variantClues: context.input.variantClues,
        specs: context.input.specs,
        category: context.input.category,
      },
      brand: context.brand,
      category: context.category,
      referenceProduct: context.referenceProduct
        ? {
            productId: context.referenceProduct.productId,
            brand: context.referenceProduct.brand,
            model: context.referenceProduct.model,
            specs: context.referenceProduct.specs,
          }
        : undefined,
      effectiveMatchSpecs: context.effectiveMatchSpecs,
      modelVariants: context.modelVariants,
      strategiesRun: context.strategiesRun,
      recallFunnel: context.recallFunnel,
      filter: context.filter,
      candidates: context.candidates.map((candidate) => ({
        productId: candidate.productId,
        brand: candidate.brand,
        model: candidate.model,
        displayName: candidate.displayName,
        source: candidate.source,
        matchScore: candidate.matchScore,
        matchComponents: candidate.matchComponents,
      })),
      scoring: context.scoring,
      decision: context.decision,
      webResearch: context.webResearch,
      resolvedProduct: context.resolvedProduct,
      totals: context.totals,
      errors: context.errors.length > 0 ? context.errors : undefined,
      ...logContext,
    };

    const headline =
      context.status === ResolutionStatus.RESOLVED
        ? `Product resolution resolved → ${context.resolvedProduct?.displayName ?? context.resolvedProduct?.id ?? "unknown"}`
        : `Product resolution unresolved (${context.decision?.reason ?? "no_decision"})`;

    if (context.status === ResolutionStatus.RESOLVED) {
      this.logger.log(headline, summary);
    } else {
      this.logger.warn(headline, summary);
    }
  }
}

function createInitialContext(
  input: ProductResolutionInput,
  options: ResolutionOptions,
): ResolutionContext {
  return {
    input,
    options,
    modelVariants: [],
    searchedKeywords: [],
    searchEvidence: [],
    candidates: [],
    strategiesRun: [],
    status: ResolutionStatus.INPUT_RECEIVED,
    totals: { durationMs: 0, cost: 0, llmCalls: 0, webSearchCalls: 0 },
    errors: [],
  };
}

function toSlimResolved(
  model: import("@ebike-backend/database").ProductModel,
): SlimResolvedModel {
  return {
    id: model.id,
    brand: model.brand?.name,
    model: model.model,
    displayName: model.displayName,
    categoryId: model.productCategory?.id,
    categoryName: model.productCategory?.name,
    specs: productSpecsSummary(model.specs, 8),
  };
}
