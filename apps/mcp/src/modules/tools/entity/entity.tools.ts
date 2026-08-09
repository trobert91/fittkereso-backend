import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import {
  collectAllFeatures,
  collectAllIssues,
  collectAllUseCases,
  Evidence,
  getPrimaryCandidate,
  getPrimaryConfidence,
  getPrimaryModel,
  isNegativeSentiment,
  isPositiveSentiment,
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  ProductReferenceRepository,
  ProductModelRepository,
  Review,
  ReviewRepository,
  Thread,
  ThreadProductCategory,
  ThreadRepository,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { compact } from "lodash";

@Injectable()
export class EntityTools {
  constructor(
    private readonly commentRepo: UserCommentRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly threadRepo: ThreadRepository,
    private readonly refRepo: ProductReferenceRepository,
    private readonly reviewRepo: ReviewRepository,
  ) {}

  @Tool({
    name: "get_comment_detail",
    description:
      "Get full comment detail — body text, parent/grandparent context, thread info, all product references with resolved products and resolution context (candidates, web search), review status, auto-fix history. Use to understand the full context around a comment without needing traces.",
    parameters: z.object({
      commentId: z.string().describe("Comment UUID"),
    }),
    annotations: { readOnlyHint: true },
  })
  async getCommentDetail(args: { commentId: string }): Promise<string> {
    const comment = await this.commentRepo.findOneOrFail({
      where: { id: args.commentId },
      relations: [
        nameOf<UserComment>("thread"),
        `${nameOf<UserComment>("thread")}.${nameOf<Thread>("categories")}`,
        `${nameOf<UserComment>("thread")}.${nameOf<Thread>("categories")}.${nameOf<ThreadProductCategory>("productCategory")}`,
        nameOf<UserComment>("parent"),
        `${nameOf<UserComment>("parent")}.${nameOf<UserComment>("parent")}`,
        nameOf<UserComment>("productReferences"),
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}`,
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}`,
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}.${nameOf<ProductModel>("brand")}`,
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}.${nameOf<ProductModel>("productCategory")}`,
      ],
    });

    const L: string[] = [];

    // Header
    L.push(`# Comment Detail`);
    L.push(`- **ID**: ${comment.id}`);
    L.push(`- **ExternalId**: ${comment.externalId}`);
    L.push(`- **Status**: ${comment.status}`);
    L.push(
      `- **Author**: ${comment.authorName ?? comment.authorId ?? "Unknown"}`,
    );
    L.push(`- **Relevance**: ${comment.relevance ?? "N/A"}`);
    if (comment.url) L.push(`- **URL**: ${comment.url}`);
    if (comment.moderations && comment.moderations.length > 0) {
      L.push("- **Moderations**:");
      for (const mod of comment.moderations) {
        const status = mod.suggestedStatus ? ` → ${mod.suggestedStatus}` : "";
        const note = mod.reviewComment ? ` — ${mod.reviewComment}` : "";
        L.push(
          `  - [${mod.source}] ${mod.reviewedBy}${status}${note} (${mod.createdAt})`,
        );
      }
    }
    L.push("");

    // Body
    L.push("## Comment Body");
    L.push("```");
    L.push(comment.body);
    L.push("```");
    L.push("");

    // Parent context
    if (comment.parent) {
      L.push("## Parent Comment");
      L.push(
        `- **ID**: ${comment.parent.id} | **ExternalId**: ${comment.parent.externalId}`,
      );
      L.push("```");
      L.push(comment.parent.body);
      L.push("```");
      L.push("");

      if (comment.parent.parent) {
        L.push("## Grandparent Comment");
        L.push(
          `- **ID**: ${comment.parent.parent.id} | **ExternalId**: ${comment.parent.parent.externalId}`,
        );
        L.push("```");
        L.push(comment.parent.parent.body);
        L.push("```");
        L.push("");
      }
    }

    // Thread info
    if (comment.thread) {
      L.push("## Thread");
      L.push(`- **ID**: ${comment.thread.id}`);
      L.push(`- **Title**: ${comment.thread.title}`);
      L.push(`- **Topic**: ${comment.thread.topic}`);
      const categoryNames = compact(
        (comment.thread.categories ?? [])
          .sort((a, b) => a.rank - b.rank)
          .map((tc) => tc.productCategory?.name),
      );
      L.push(
        `- **Categories**: ${categoryNames.length > 0 ? categoryNames.join(", ") : "None"}`,
      );
      L.push("");
    }

    // Product references
    const refs = comment.productReferences ?? [];
    if (refs.length > 0) {
      L.push(`## Product References (${refs.length})`);
      L.push(
        "| Display Name | Resolved | Brand | Confidence | Sentiment | Relevance | Enabled | Flagged |",
      );
      L.push(
        "|-------------|----------|-------|------------|-----------|-----------|---------|---------|",
      );

      for (const ref of refs) {
        const displayName =
          ref.context?.identification?.displayName ?? "Unknown";
        const primaryModel = getPrimaryModel(ref);
        const primaryConfidence = getPrimaryConfidence(ref);
        const resolved = primaryModel ? primaryModel.displayName : "—";
        const brand = primaryModel?.brand?.name ?? "—";
        const confidence =
          primaryConfidence != null ? primaryConfidence.toFixed(2) : "—";
        const ambiguityTag = ref.ambiguousResolution
          ? ` [+${(ref.candidates?.length ?? 1) - 1} runner-up(s)]`
          : "";
        L.push(
          `| ${displayName}${ambiguityTag} | ${resolved} | ${brand} | ${confidence} | ${ref.sentiment ?? "—"} | ${ref.relevance} | ${ref.enabled} | ${ref.flagged} |`,
        );
      }
      L.push("");

      // Extraction details per reference
      for (const ref of refs) {
        const displayName =
          ref.context?.identification?.displayName ?? "Unknown";
        const details: string[] = [];
        if (ref.experience) details.push(`experience=${ref.experience}`);
        if (ref.depth) details.push(`depth=${ref.depth}`);
        if (ref.intents?.length)
          details.push(`intents=[${ref.intents.join(", ")}]`);
        const allFeatures = collectAllFeatures(ref);
        const allUseCases = collectAllUseCases(ref);
        const allIssues = collectAllIssues(ref);
        const useCaseLabels = allUseCases.map((e) => e.label);
        const positiveLabels = allFeatures
          .filter((e) => isPositiveSentiment(e.sentiment))
          .map((e) => e.label);
        const negativeLabels = allFeatures
          .filter((e) => isNegativeSentiment(e.sentiment))
          .map((e) => e.label);
        const issueLabels = allIssues.map((e) => `${e.label}/${e.sentiment}`);
        if (useCaseLabels.length)
          details.push(`useCases=[${useCaseLabels.join(", ")}]`);
        if (positiveLabels.length)
          details.push(`positiveFeatures=[${positiveLabels.join(", ")}]`);
        if (negativeLabels.length)
          details.push(`negativeFeatures=[${negativeLabels.join(", ")}]`);
        if (issueLabels.length)
          details.push(`issues=[${issueLabels.join(", ")}]`);
        if (details.length > 0) {
          L.push(`**${displayName}**: ${details.join(" | ")}`);
        }
      }
      L.push("");

      // Resolution context per reference
      for (const ref of refs) {
        if (!ref.context) continue;
        const ctx = ref.context;
        const searchCtx = ref.searchContext;
        const name = ctx.identification?.displayName ?? "Unknown";

        L.push(`### Resolution Context: "${name}"`);

        // Status & confidence
        if (searchCtx) {
          L.push(`- **Search Status**: ${searchCtx.status}`);
        }
        const refConfidence = getPrimaryConfidence(ref);
        if (refConfidence != null) {
          L.push(`- **Resolution Confidence**: ${refConfidence}`);
        }
        if (ref.candidates && ref.candidates.length > 1) {
          L.push(`- **Candidate Set** (${ref.candidates.length}):`);
          for (const candidate of ref.candidates) {
            const tag = candidate.isPrimary ? " [primary]" : "";
            L.push(
              `  - ${candidate.model?.displayName ?? candidate.model?.id ?? "—"}${tag} — weight=${candidate.weight.toFixed(2)}, confidence=${candidate.confidence.toFixed(2)}`,
            );
          }
        }
        if (searchCtx) {
          L.push(
            `- **Options**: mode=${searchCtx.options?.mode ?? "—"}, webSearch=${searchCtx.options?.webSearchEnabled ?? "—"}`,
          );
          L.push(
            `- **Cost**: $${searchCtx.totals?.cost?.toFixed(4) ?? "—"}, duration: ${searchCtx.totals?.durationMs ?? "—"}ms`,
          );
        }

        // Input
        L.push(
          `- **Input**: brand=${ctx.identification?.brand ?? "—"}, model=${ctx.identification?.model ?? "—"}, displayName=${ctx.identification?.displayName ?? "—"}`,
        );

        if (searchCtx) {
          const decision = searchCtx.decision;
          if (decision) {
            L.push(
              `- **Decision**: ${decision.kind} (${decision.reason}, confidence ${decision.confidence})`,
            );
            if (decision.evidenceSummary) {
              L.push(`  - ${decision.evidenceSummary}`);
            }
          }
          const scoring = searchCtx.scoring;
          if (scoring?.bestCandidate) {
            L.push(
              `- **Matcher Best**: ${scoring.bestCandidate.alias} (score ${scoring.bestCandidate.score})`,
            );
            if (scoring.secondScore != null) {
              L.push(`  - runner-up score: ${scoring.secondScore}`);
            }
            if (scoring.failedGates?.length) {
              L.push(`  - failed gates: ${scoring.failedGates.join(", ")}`);
            }
          }
          const variants = searchCtx.modelVariants ?? [];
          if (variants.length > 0) {
            L.push(
              `- **Model Variants**: ${variants.map((v) => `${v.model} (${v.source})`).join(", ")}`,
            );
          }
          const funnel = searchCtx.recallFunnel;
          if (funnel) {
            L.push(
              `- **Recall Funnel**: fuzzy=${funnel.fuzzyHits}, embedding=${funnel.embeddingHits}, web=${funnel.webHits}, after-dedupe=${funnel.afterDedupe}`,
            );
          }
          if (searchCtx.strategiesRun?.length) {
            L.push(
              `- **Strategies Run**: ${searchCtx.strategiesRun.join(", ")}`,
            );
          }
          const candidates = searchCtx.candidates ?? [];
          if (candidates.length > 0) {
            L.push(`- **Candidates** (${candidates.length}):`);
            for (const c of candidates.slice(0, 5)) {
              const scoreStr =
                c.matchScore != null ? c.matchScore.toString() : "—";
              L.push(
                `  - ${c.brand ?? "—"} ${c.displayName ?? c.model ?? "—"} (score: ${scoreStr}, source: ${c.source ?? "—"})`,
              );
            }
            if (candidates.length > 5) {
              L.push(`  - ... and ${candidates.length - 5} more`);
            }
          }
          if (searchCtx.webResearch?.queries.length) {
            L.push(
              `- **Web Queries** (${searchCtx.webResearch.queries.length}):`,
            );
            for (const query of searchCtx.webResearch.queries.slice(0, 3)) {
              L.push(
                `  - [${query.intent}] "${query.keyword}" — provider=${query.provider}, results=${query.serpResultCount}, cacheHit=${query.cacheHit}`,
              );
            }
            if (searchCtx.webResearch.extractedModelNumbers.length) {
              L.push(
                `  - extracted SKUs: ${searchCtx.webResearch.extractedModelNumbers.join(", ")}`,
              );
            }
            if (searchCtx.webResearch.webOnlyModels.length) {
              L.push(
                `  - web-only models (no catalog hit): ${searchCtx.webResearch.webOnlyModels.join(", ")}`,
              );
            }
          }
          if (searchCtx.errors?.length) {
            L.push(`- **Errors** (${searchCtx.errors.length}):`);
            for (const error of searchCtx.errors) {
              L.push(`  - [${error.phase}] ${error.message}`);
            }
          }
        }

        L.push("");
      }
    }

    return L.join("\n");
  }

  @Tool({
    name: "get_product_detail",
    description:
      "Get detailed product information — display name, brand, model, specs, aliases, category, ratings. Use to investigate product resolution accuracy and verify if the correct product was matched.",
    parameters: z.object({
      productId: z.string().optional().describe("Product model UUID"),
      slug: z
        .string()
        .optional()
        .describe("Product slug (alternative to productId)"),
    }),
    annotations: { readOnlyHint: true },
  })
  async getProductDetail(args: {
    productId?: string;
    slug?: string;
  }): Promise<string> {
    if (!args.productId && !args.slug) {
      return "Error: provide either productId or slug";
    }

    const where = args.productId ? { id: args.productId } : { slug: args.slug };

    const product = await this.productRepo.findOneOrFail({
      where,
      relations: ["brand", "productCategory", "aliases", "rating"],
    });

    const L: string[] = [];

    // Header
    L.push(`# Product Detail`);
    L.push(`- **ID**: ${product.id}`);
    L.push(`- **Display Name**: ${product.displayName}`);
    L.push(`- **Model**: ${product.model}`);
    L.push(
      `- **Normalized Name**: ${product.brand?.name ?? "?"} / ${product.normalizedName}`,
    );
    L.push(`- **Enabled**: ${product.enabled}`);
    if (product.slug) L.push(`- **Slug**: ${product.slug}`);
    if (product.releaseYear)
      L.push(`- **Release Year**: ${product.releaseYear}`);
    L.push("");

    // Brand
    if (product.brand) {
      L.push("## Brand");
      L.push(`- **Name**: ${product.brand.name}`);
      L.push(`- **ID**: ${product.brand.id}`);
      L.push("");
    }

    // Category
    if (product.productCategory) {
      L.push("## Category");
      L.push(`- **Name**: ${product.productCategory.name}`);
      L.push("");
    }

    // Specs
    if (product.specs && Object.keys(product.specs).length > 0) {
      L.push("## Specs");
      for (const [key, value] of Object.entries(product.specs)) {
        L.push(`- **${key}**: ${value}`);
      }
      L.push("");
    }

    // Aliases
    const aliases = product.aliases ?? [];
    if (aliases.length > 0) {
      L.push(`## Aliases (${aliases.length})`);
      for (const alias of aliases) {
        L.push(`- ${alias.alias}`);
      }
      L.push("");
    }

    // Rating
    if (product.rating) {
      L.push("## Rating");
      L.push(
        `- **Strong Positive**: ${product.rating.strongPositiveReviewCount ?? 0}`,
      );
      L.push(`- **Positive**: ${product.rating.positiveReviewCount ?? 0}`);
      L.push(`- **Negative**: ${product.rating.negativeReviewCount ?? 0}`);
      L.push(
        `- **Strong Negative**: ${product.rating.strongNegativeReviewCount ?? 0}`,
      );
      L.push(`- **Mixed**: ${product.rating.mixedReviewCount ?? 0}`);
      L.push(`- **Neutral**: ${product.rating.neutralReviewCount ?? 0}`);
      L.push("");
    }

    // Description
    if (product.description) {
      L.push("## Description");
      L.push(product.description);
      L.push("");
    }

    return L.join("\n");
  }

  @Tool({
    name: "get_thread_detail",
    description:
      "Get thread detail with comment status breakdown — title, category, URL, comment counts by status, product reference resolution summary. Use to understand processing progress without needing debug traces.",
    parameters: z.object({
      threadId: z.string().describe("Thread UUID"),
    }),
    annotations: { readOnlyHint: true },
  })
  async getThreadDetail(args: { threadId: string }): Promise<string> {
    const thread = await this.threadRepo.findOneOrFail({
      where: { id: args.threadId },
      relations: [
        nameOf<Thread>("categories"),
        `${nameOf<Thread>("categories")}.${nameOf<ThreadProductCategory>("productCategory")}`,
      ],
    });

    // Comment status distribution
    const commentStatusColumn = `c.${nameOf<UserComment>("status")}`;
    const statusDist: { status: string; count: string }[] =
      await this.commentRepo.repo
        .createQueryBuilder("c")
        .select(commentStatusColumn, "status")
        .addSelect("COUNT(*)::int", "count")
        .where("c.threadId = :threadId", { threadId: args.threadId })
        .groupBy(commentStatusColumn)
        .orderBy("count", "DESC")
        .getRawMany();

    // Product reference resolution distribution
    const refDist: {
      resolved: string;
      count: string;
      flaggedCount: string;
    }[] = await this.refRepo.repo
      .createQueryBuilder("pr")
      .innerJoin(`pr.${nameOf<ProductReference>("comment")}`, "c")
      .where("c.threadId = :threadId", { threadId: args.threadId })
      .select(
        // "resolved" if any candidate row exists for this ref; "unresolved" otherwise.
        `CASE WHEN EXISTS (SELECT 1 FROM product_reference_candidate prc WHERE prc."referenceId" = pr.id) THEN 'resolved' ELSE 'unresolved' END`,
        "resolved",
      )
      .addSelect("COUNT(*)::int", "count")
      .addSelect(
        `SUM(CASE WHEN pr.${nameOf<ProductReference>("flagged")} THEN 1 ELSE 0 END)::int`,
        "flaggedCount",
      )
      .groupBy("resolved")
      .getRawMany();

    const L: string[] = [];

    // Header
    L.push(`# Thread Detail`);
    L.push(`- **ID**: ${thread.id}`);
    L.push(`- **Title**: ${thread.title}`);
    L.push(`- **Topic**: ${thread.topic}`);
    const sortedCategories = (thread.categories ?? []).sort(
      (a, b) => a.rank - b.rank,
    );
    const categoryDisplay =
      sortedCategories.length > 0
        ? sortedCategories
            .map(
              (tc) =>
                `${tc.productCategory?.name} (${tc.productCategory?.id}, confidence: ${tc.confidence}, rank: ${tc.rank})`,
            )
            .join(", ")
        : "None";
    L.push(`- **Categories**: ${categoryDisplay}`);
    L.push(`- **Status**: ${thread.status}`);
    L.push(`- **Comment Count**: ${thread.commentCount ?? "—"}`);
    if (thread.url) L.push(`- **URL**: ${thread.url}`);
    L.push(`- **Process Running**: ${thread.processRunning}`);
    if (thread.lastSynced) L.push(`- **Last Synced**: ${thread.lastSynced}`);
    L.push("");

    // Comment status distribution
    if (statusDist.length > 0) {
      L.push("## Comment Status Distribution");
      L.push("| Status | Count |");
      L.push("|--------|-------|");
      for (const row of statusDist) {
        L.push(`| ${row.status} | ${row.count} |`);
      }
      L.push("");
    }

    // Product reference summary
    if (refDist.length > 0) {
      const totalFlagged = refDist.reduce(
        (sum, r) => sum + Number(r.flaggedCount),
        0,
      );
      L.push("## Product Reference Summary");
      L.push("| Resolved | Count | Flagged |");
      L.push("|----------|-------|---------|");
      for (const row of refDist) {
        L.push(`| ${row.resolved} | ${row.count} | ${row.flaggedCount} |`);
      }
      if (totalFlagged > 0) {
        L.push("");
        L.push(`**Total Flagged References**: ${totalFlagged}`);
      }
      L.push("");
    }

    return L.join("\n");
  }

  @Tool({
    name: "get_review_detail",
    description:
      "Get full detail for a single Review by ID — all review fields (sentiment, experience, intents, depth, reviewScore, quote/upvote/downvote totals, useCases, positive/negative features, quotes, reviewDetails), the resolved product (with brand/category), and every ProductReference attached to the review with its comment body, parent/grandparent/great-grandparent context, thread info, and resolution details. Mirrors the admin GET /admin-review/:id endpoint.",
    parameters: z.object({
      reviewId: z.string().describe("Review UUID"),
    }),
    annotations: { readOnlyHint: true },
  })
  async getReviewDetail(args: { reviewId: string }): Promise<string> {
    const review = await this.reviewRepo.findOneOrFail({
      where: { id: args.reviewId },
      relations: [
        nameOf<Review>("model"),
        `${nameOf<Review>("model")}.${nameOf<ProductModel>("brand")}`,
        `${nameOf<Review>("model")}.${nameOf<ProductModel>("productCategory")}`,
        nameOf<Review>("candidates"),
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("thread")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("parent")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("parent")}.${nameOf<UserComment>("parent")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("parent")}.${nameOf<UserComment>("parent")}.${nameOf<UserComment>("parent")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("candidates")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}.${nameOf<ProductModel>("brand")}`,
      ],
    });

    const L: string[] = [];

    // Header
    L.push(`# Review Detail`);
    L.push(`- **ID**: ${review.id}`);
    L.push(`- **User**: ${review.username} (${review.userId})`);
    L.push(`- **Enabled**: ${review.enabled}`);
    L.push(`- **Platform**: ${review.platform}`);
    L.push(`- **Sentiment**: ${review.sentiment}`);
    L.push(`- **Experience**: ${review.experience}`);
    L.push(`- **Intents**: ${review.intents?.join(", ") ?? "—"}`);
    L.push(`- **Depth**: ${review.depth ?? "—"}`);
    const score =
      review.reviewScore !== null && review.reviewScore !== undefined
        ? review.reviewScore.toFixed(4)
        : "—";
    L.push(`- **Review Score**: ${score}`);
    L.push(`- **Total Upvotes**: ${review.totalUpvotes ?? 0}`);
    L.push(`- **Total Downvotes**: ${review.totalDownvotes ?? 0}`);
    L.push(`- **Total Quote Count**: ${review.totalQuoteCount ?? 0}`);
    L.push(`- **Part Count**: ${review.partCount ?? 0}`);
    if (review.labels?.length) {
      const byType = new Map<string, string[]>();
      for (const label of review.labels) {
        const bucket = byType.get(label.type) ?? [];
        bucket.push(`${label.label} (${label.sentiment})`);
        byType.set(label.type, bucket);
      }
      for (const [type, items] of byType) {
        L.push(`- **${type} labels**: ${items.join(", ")}`);
      }
    }
    L.push(
      `- **Created**: ${review.createdAt ? review.createdAt.toISOString() : "—"}`,
    );
    L.push(
      `- **External Created**: ${review.externalCreationTs ? review.externalCreationTs.toISOString() : "—"}`,
    );
    L.push(
      `- **Last Evaluated**: ${review.lastEvaluatedAt ? review.lastEvaluatedAt.toISOString() : "—"}`,
    );
    if (review.deletedAt) {
      L.push(`- **Deleted At**: ${review.deletedAt.toISOString()}`);
    }
    L.push("");

    // Product
    if (review.model) {
      L.push("## Product");
      L.push(`- **ID**: ${review.model.id}`);
      L.push(`- **Display Name**: ${review.model.displayName}`);
      L.push(`- **Brand**: ${review.model.brand?.name ?? "—"}`);
      L.push(`- **Category**: ${review.model.productCategory?.name ?? "—"}`);
      if (review.model.slug) L.push(`- **Slug**: ${review.model.slug}`);
      L.push("");
    }

    // Top-level quotes
    const reviewQuotes = review.quotes ?? [];
    if (reviewQuotes.length > 0) {
      L.push(`## Review Quotes (${reviewQuotes.length})`);
      for (const quote of reviewQuotes) {
        L.push(`> ${quote.text ?? JSON.stringify(quote)}`);
      }
      L.push("");
    }

    // Review details (jsonb)
    if (review.reviewDetails) {
      L.push("## Review Details");
      L.push("```json");
      L.push(JSON.stringify(review.reviewDetails, null, 2));
      L.push("```");
      L.push("");
    }

    // Product references — walked via the linked candidates on this review.
    const linkedCandidates = review.candidates ?? [];
    const referencesFromCandidates = compact(
      linkedCandidates.map((candidate) => candidate.reference),
    );
    if (referencesFromCandidates.length > 0) {
      L.push(`## Product References (${referencesFromCandidates.length})`);
      L.push("");

      for (const reference of referencesFromCandidates) {
        const comment = reference.comment;
        L.push(`### Reference ${reference.id}`);
        L.push(
          `- **Enabled**: ${reference.enabled} | **Flagged**: ${reference.flagged}`,
        );
        L.push(
          `- **Sentiment**: ${reference.sentiment ?? "—"} | **Experience**: ${reference.experience ?? "—"} | **Depth**: ${reference.depth ?? "—"}`,
        );
        L.push(`- **Intents**: ${reference.intents?.join(", ") ?? "—"}`);
        L.push(`- **Relevance**: ${reference.relevance}`);
        const refConfidence = getPrimaryConfidence(reference);
        if (refConfidence != null) {
          L.push(`- **Resolution Confidence**: ${refConfidence.toFixed(2)}`);
        }
        const categoryDisabled =
          reference.productCategory != null &&
          reference.productCategory.extractionEnabled === false;
        L.push(
          `- **Resolution Finished**: ${reference.resolutionFinished} | **Category Disabled**: ${categoryDisabled} | **Attempts**: ${reference.resolutionAttemptCount}`,
        );
        const resolvedModel = getPrimaryModel(reference);
        if (resolvedModel) {
          L.push(
            `- **Resolved Model**: ${resolvedModel.displayName} (${resolvedModel.brand?.name ?? "—"})`,
          );
        }
        if (reference.candidates && reference.candidates.length > 1) {
          L.push(`- **Candidate Set** (${reference.candidates.length}):`);
          for (const candidate of reference.candidates) {
            const tag = candidate.isPrimary ? " [primary]" : "";
            L.push(
              `  - ${candidate.model?.displayName ?? candidate.model?.id ?? "—"}${tag} — weight=${candidate.weight.toFixed(2)}, confidence=${candidate.confidence.toFixed(2)}`,
            );
          }
        }
        if (reference.categoryHint) {
          L.push(`- **Category Hint**: ${reference.categoryHint}`);
        }
        const allFeatures = collectAllFeatures(reference);
        const allUseCases = collectAllUseCases(reference);
        const allIssues = collectAllIssues(reference);
        const useCaseLabels = allUseCases.map((e) => e.label);
        const positiveLabels = allFeatures
          .filter((e) => isPositiveSentiment(e.sentiment))
          .map((e) => e.label);
        const negativeLabels = allFeatures
          .filter((e) => isNegativeSentiment(e.sentiment))
          .map((e) => e.label);
        const issueLabels = allIssues.map((e) => `${e.label}/${e.sentiment}`);
        if (useCaseLabels.length) {
          L.push(`- **Use Cases**: ${useCaseLabels.join(", ")}`);
        }
        if (positiveLabels.length) {
          L.push(`- **Positive Features**: ${positiveLabels.join(", ")}`);
        }
        if (negativeLabels.length) {
          L.push(`- **Negative Features**: ${negativeLabels.join(", ")}`);
        }
        if (issueLabels.length) {
          L.push(`- **Issues**: ${issueLabels.join(", ")}`);
        }
        // Surface LLM-emitted reference-level labels separately for debugging.
        if (reference.features?.length || reference.useCases?.length) {
          const refLevelParts: string[] = [];
          if (reference.features?.length) {
            refLevelParts.push(
              `features=[${reference.features.map((e: Evidence) => `${e.label}/${e.sentiment ?? "—"}`).join(", ")}]`,
            );
          }
          if (reference.useCases?.length) {
            refLevelParts.push(
              `useCases=[${reference.useCases.map((e: Evidence) => `${e.label}/${e.sentiment ?? "—"}`).join(", ")}]`,
            );
          }
          L.push(`- **Ref-Level Labels (LLM)**: ${refLevelParts.join(" | ")}`);
        }
        if (reference.issueSeverity != null) {
          L.push(`- **Issue Severity**: ${reference.issueSeverity}`);
        }
        if (reference.openIssueSeverity != null) {
          L.push(`- **Open Issue Severity**: ${reference.openIssueSeverity}`);
        }
        if (reference.reviewComment) {
          L.push(`- **Review Comment**: ${reference.reviewComment}`);
        }

        if (comment) {
          L.push("");
          L.push(`#### Comment`);
          L.push(
            `- **ID**: ${comment.id} | **ExternalId**: ${comment.externalId}`,
          );
          L.push(
            `- **Author**: ${comment.authorName ?? comment.authorId ?? "Unknown"}`,
          );
          L.push(`- **Status**: ${comment.status}`);
          L.push(
            `- **Upvotes**: ${comment.upvotes ?? 0} | **Downvotes**: ${comment.downvotes ?? 0}`,
          );
          if (comment.url) L.push(`- **URL**: ${comment.url}`);
          if (comment.thread) {
            L.push(
              `- **Thread**: ${comment.thread.title} (${comment.thread.id})`,
            );
          }
          L.push("");
          L.push("**Body:**");
          L.push("```");
          L.push(comment.body);
          L.push("```");

          if (comment.parent) {
            L.push("");
            L.push("**Parent:**");
            L.push("```");
            L.push(comment.parent.body);
            L.push("```");

            if (comment.parent.parent) {
              L.push("");
              L.push("**Grandparent:**");
              L.push("```");
              L.push(comment.parent.parent.body);
              L.push("```");

              if (comment.parent.parent.parent) {
                L.push("");
                L.push("**Great-grandparent:**");
                L.push("```");
                L.push(comment.parent.parent.parent.body);
                L.push("```");
              }
            }
          }
        }

        const referenceQuotes = reference.quotes ?? [];
        if (referenceQuotes.length > 0) {
          L.push("");
          L.push(`**Quotes (${referenceQuotes.length}):**`);
          for (const quote of referenceQuotes) {
            L.push(`> ${quote.text ?? JSON.stringify(quote)}`);
          }
        }

        if (reference.referenceDetails) {
          L.push("");
          L.push("**Reference Details:**");
          L.push("```json");
          L.push(JSON.stringify(reference.referenceDetails, null, 2));
          L.push("```");
        }

        L.push("");
      }
    }

    return L.join("\n");
  }

  @Tool({
    name: "search_reviews",
    description:
      "Search reviews — list all reviews with optional product filter. Returns full review detail including all fields, review parts with comment bodies and quotes. Use to inspect reviews for a specific product or browse recent reviews.",
    parameters: z.object({
      productId: z.string().optional().describe("Filter by product UUID"),
      limit: z
        .number()
        .optional()
        .describe("Max results to return (default 20, max 50)"),
    }),
    annotations: { readOnlyHint: true },
  })
  async searchReviews(args: {
    productId?: string;
    limit?: number;
  }): Promise<string> {
    const take = Math.min(args.limit ?? 20, 50);

    const queryBuilder = this.reviewRepo.repo
      .createQueryBuilder("review")
      .leftJoinAndSelect(`review.${nameOf<Review>("model")}`, "model")
      .leftJoinAndSelect(`model.${nameOf<ProductModel>("brand")}`, "brand")
      .leftJoinAndSelect(`review.${nameOf<Review>("candidates")}`, "candidates")
      .leftJoinAndSelect(
        `candidates.${nameOf<ProductReferenceCandidate>("reference")}`,
        "reference",
      )
      .leftJoinAndSelect(
        `reference.${nameOf<ProductReference>("comment")}`,
        "refComment",
      )
      .leftJoinAndSelect(
        `refComment.${nameOf<UserComment>("thread")}`,
        "refThread",
      )
      .orderBy(`review.${nameOf<Review>("createdAt")}`, "DESC")
      .take(take);

    if (args.productId) {
      queryBuilder.where(`model.${nameOf<ProductModel>("id")} = :productId`, {
        productId: args.productId,
      });
    }

    const [reviews, total] = await queryBuilder.getManyAndCount();

    if (reviews.length === 0) {
      return "No reviews found matching the criteria.";
    }

    const lines: string[] = [];
    lines.push(`# Reviews (${reviews.length} of ${total})`);
    lines.push("");

    for (const review of reviews) {
      const productName = review.model?.displayName ?? "—";
      const brandName = review.model?.brand?.name ?? "—";
      const score =
        review.reviewScore !== null && review.reviewScore !== undefined
          ? review.reviewScore.toFixed(2)
          : "—";
      const created = review.createdAt
        ? review.createdAt.toISOString().slice(0, 10)
        : "—";
      const externalCreated = review.externalCreationTs
        ? review.externalCreationTs.toISOString().slice(0, 10)
        : "—";

      lines.push(`---`);
      lines.push(`## Review ${review.id}`);
      lines.push(`- **Product**: ${productName}`);
      lines.push(`- **Brand**: ${brandName}`);
      lines.push(`- **User**: ${review.username} (${review.userId})`);
      lines.push(`- **Sentiment**: ${review.sentiment}`);
      lines.push(`- **Experience**: ${review.experience}`);
      lines.push(`- **Intents**: ${review.intents?.join(", ") ?? "—"}`);
      lines.push(`- **Depth**: ${review.depth ?? "—"}`);
      lines.push(`- **Score**: ${score}`);
      lines.push(
        `- **Upvotes**: ${review.totalUpvotes ?? 0} | **Downvotes**: ${review.totalDownvotes ?? 0}`,
      );
      lines.push(`- **Total Quotes**: ${review.totalQuoteCount ?? 0}`);
      lines.push(`- **Enabled**: ${review.enabled}`);
      lines.push(`- **Platform**: ${review.platform}`);
      if (review.labels?.length) {
        const labelLines = review.labels.map(
          (l) => `${l.type}/${l.label}=${l.sentiment}`,
        );
        lines.push(`- **Labels**: ${labelLines.join(", ")}`);
      }
      lines.push(
        `- **Created**: ${created} | **External Created**: ${externalCreated}`,
      );
      if (review.deletedAt) {
        lines.push(
          `- **Deleted At**: ${review.deletedAt.toISOString().slice(0, 10)}`,
        );
      }
      lines.push("");

      const productReferences = compact(
        (review.candidates ?? []).map((candidate) => candidate.reference),
      );
      if (productReferences.length > 0) {
        lines.push(`### Product References (${productReferences.length})`);
        for (const reference of productReferences) {
          const comment = reference.comment;
          lines.push(`#### Reference ${reference.id}`);
          if (comment?.thread?.title)
            lines.push(`- **Thread**: ${comment.thread.title}`);
          if (comment?.thread?.topic)
            lines.push(`- **Topic**: ${comment.thread.topic}`);
          if (comment?.url) lines.push(`- **URL**: ${comment.url}`);
          lines.push(
            `- **Sentiment**: ${reference.sentiment ?? "—"} | **Experience**: ${reference.experience ?? "—"} | **Depth**: ${reference.depth ?? "—"}`,
          );
          lines.push(`- **Intents**: ${reference.intents?.join(", ") ?? "—"}`);
          const refAllFeatures = collectAllFeatures(reference);
          const refPositiveLabels = refAllFeatures
            .filter((e) => isPositiveSentiment(e.sentiment))
            .map((e) => e.label);
          const refNegativeLabels = refAllFeatures
            .filter((e) => isNegativeSentiment(e.sentiment))
            .map((e) => e.label);
          const refIssueLabels = collectAllIssues(reference).map(
            (e) => `${e.label}/${e.sentiment}`,
          );
          if (refPositiveLabels.length)
            lines.push(
              `- **Positive Features**: ${refPositiveLabels.join(", ")}`,
            );
          if (refNegativeLabels.length)
            lines.push(
              `- **Negative Features**: ${refNegativeLabels.join(", ")}`,
            );
          if (refIssueLabels.length)
            lines.push(`- **Issues**: ${refIssueLabels.join(", ")}`);
          lines.push(
            `- **Upvotes**: ${comment?.upvotes ?? 0} | **Downvotes**: ${comment?.downvotes ?? 0}`,
          );
          lines.push("");
          lines.push("**Body:**");
          lines.push("```");
          lines.push(comment?.body ?? "");
          lines.push("```");

          const quotes = reference.quotes ?? [];
          if (quotes.length > 0) {
            lines.push("");
            lines.push(`**Quotes (${quotes.length}):**`);
            for (const quote of quotes) {
              lines.push(`> ${quote.text ?? JSON.stringify(quote)}`);
            }
          }
          lines.push("");
        }
      }
    }

    return lines.join("\n");
  }
}
