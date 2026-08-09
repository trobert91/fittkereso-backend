import { Injectable } from "@nestjs/common";
import {
  CommentStatus,
  ExperienceType,
  getPrimaryModel,
  ProductReference,
  resolveMediaContent,
  UserComment,
} from "@ebike-backend/database";
import { ProductSpecContextService } from "@ebike-backend/product";
import { Subtree } from "../models/subtree.model";
import { AuthorAffinityEntry } from "../models/product-registry.model";
import { ThreadContext } from "../models/thread-context";
import { buildExtractionSystemPrompt } from "../prompts/subtree-extractor.prompt";
import { buildIdentificationSystemPrompt } from "../prompts/subtree-identification.prompt";
import { buildProductDiscoverySystemPrompt } from "../prompts/product-discovery.prompt";
import { buildCommentIdentificationSystemPrompt } from "../prompts/comment-identification.prompt";
import { ThreadCategoryConfig } from "../models/thread-context";
import { LLMMappedProduct } from "../schemas/subtree-identification.schema";
import {
  EnrichedDiscoveredProduct,
  HeldResolution,
} from "../models/discovered-product.model";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AssembledPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface CommentsSectionOptions {
  /** When provided, PLAN nodes with entries get [products: Brand Model, ...] annotation. */
  planProductAnnotations?: Map<string, LLMMappedProduct[]>;
  /** When true, CONTEXT nodes are stripped from the output entirely. */
  stripContext?: boolean;
}

/**
 * An enriched distinct product paired with its held resolution — the input to
 * the comment-identification prompt's resolved-products section.
 */
export interface ResolvedDiscoveredProduct {
  enriched: EnrichedDiscoveredProduct;
  heldResolution: HeldResolution;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class PromptAssemblyService {
  constructor(private readonly productSpecContext: ProductSpecContextService) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Build the full extraction prompt for a subtree. */
  buildExtractionPrompt(
    subtree: Subtree,
    context: ThreadContext,
    categoryConfigOverride?: ThreadCategoryConfig[],
    commentsSectionOptions?: CommentsSectionOptions,
  ): AssembledPrompt {
    const systemPrompt = buildExtractionSystemPrompt(
      categoryConfigOverride ?? context.categoryConfigs,
    );
    const commentsSection = this.buildCommentsSection(
      subtree,
      context,
      commentsSectionOptions,
    );
    const resolvedProductsSection = this.buildResolvedProductsSection(subtree);
    // Cheat sheet dropped from extraction: the per-comment resolved-products
    // section (real DB specs) is the load-bearing input, and extraction is
    // forbidden from inventing products outside it — the global cheat sheet was
    // ambient context the task never referenced. Labeling + validation already
    // exclude it, so pass-2 locality is automatic.
    const userPrompt = this.buildUserPrompt(
      context,
      commentsSection,
      subtree.isOpSubtree,
      resolvedProductsSection,
      { includeCheatSheet: false },
    );

    return { systemPrompt, userPrompt };
  }

  /** Build the product identification prompt for a subtree. */
  buildIdentificationPrompt(
    subtree: Subtree,
    context: ThreadContext,
  ): AssembledPrompt {
    const systemPrompt = buildIdentificationSystemPrompt(
      context.categoryConfigs,
    );
    const commentsSection = this.buildCommentsSection(subtree, context);
    const userPrompt = this.buildUserPrompt(
      context,
      commentsSection,
      subtree.isOpSubtree,
    );

    return { systemPrompt, userPrompt };
  }

  /**
   * Build the pass-1 product discovery prompt for a wide subtree. Uses the
   * accumulated cheat sheet (ON) so the model can dedup new products against
   * what earlier subtrees already surfaced.
   */
  buildDiscoveryPrompt(
    subtree: Subtree,
    context: ThreadContext,
  ): AssembledPrompt {
    const systemPrompt = buildProductDiscoverySystemPrompt(
      context.categoryConfigs,
    );
    const commentsSection = this.buildCommentsSection(subtree, context);
    const userPrompt = this.buildUserPrompt(
      context,
      commentsSection,
      subtree.isOpSubtree,
    );

    return { systemPrompt, userPrompt };
  }

  /**
   * Build the pass-1 comment-identification prompt: map each comment to the
   * already-resolved distinct products. The resolved set replaces the cheat
   * sheet as the product reference (cheat sheet OFF), rendered with real specs
   * so the model can disambiguate ("the 34-inch one") against catalog data.
   */
  buildCommentIdentificationPrompt(
    subtree: Subtree,
    context: ThreadContext,
    resolved: ResolvedDiscoveredProduct[],
  ): AssembledPrompt {
    const systemPrompt = buildCommentIdentificationSystemPrompt(
      context.categoryConfigs,
    );
    const commentsSection = this.buildCommentsSection(subtree, context);
    const discoveredProductsSection =
      this.buildDiscoveredProductsSection(resolved);
    const userPrompt = this.buildUserPrompt(
      context,
      commentsSection,
      subtree.isOpSubtree,
      undefined,
      { includeCheatSheet: false, discoveredProductsSection },
    );

    return { systemPrompt, userPrompt };
  }

  /**
   * Render the resolved distinct-product set for the comment-identification
   * prompt: one line per product, keyed by its discovery letter, with the
   * resolved catalog name + specs (or the discovered name when unresolved).
   * Format:
   *   A: LG 34GS95QE-B (34" OLED, 240Hz)
   *   B: Samsung S32FG810SU (32" QD-OLED, 240Hz) [unresolved]
   */
  buildDiscoveredProductsSection(
    resolved: ResolvedDiscoveredProduct[],
  ): string {
    const lines = resolved.map(({ enriched, heldResolution }) => {
      const resolvedModel = heldResolution.result?.resolvedModel;
      const name =
        resolvedModel?.displayName ??
        `${enriched.discovered.brand} ${enriched.discovered.model}`.trim();
      const orderedSpecs = resolvedModel
        ? this.productSpecContext.getExtractionOrderedSpecs(
            resolvedModel.orderedSpecs,
            enriched.productCategory,
          )
        : [];
      const specsStr = orderedSpecs.length
        ? ` (${orderedSpecs.map((s) => s.value).join(", ")})`
        : "";
      const unresolvedTag = resolvedModel ? "" : " [unresolved]";
      return `${enriched.discovered.linkLabel}: ${name}${specsStr}${unresolvedTag}`;
    });

    return lines.join("\n");
  }

  /**
   * Build the full labeling user prompt: subreddit + OP (when !isOpSubtree)
   * + DFS-ordered comment tree with refs/quotes inlined under each PLAN node
   * that carries refs.
   *
   * Note: the registry cheat sheet is intentionally omitted here. Labeling
   * does not resolve products — each ref already carries its canonical name
   * and full known specs in the inline `refs:` block, identified by a
   * bracketed [Aa]/[Ba] code. Including the cheat sheet (which lists
   * products by display name) was empirically causing the model to use
   * display names as `productId` instead of the bracketed codes.
   */
  buildLabelingPrompt(
    subtree: Subtree,
    context: ThreadContext,
    commentLabelMap: Map<string, string>,
  ): string {
    const commentsSection = this.buildLabelingTree(
      subtree,
      context,
      commentLabelMap,
    );
    return this.buildUserPrompt(
      context,
      commentsSection,
      subtree.isOpSubtree,
      undefined,
      { includeCheatSheet: false },
    );
  }

  /**
   * Build the DFS-ordered [PLAN]/[CONTEXT] tree for the labeling prompt.
   * PLAN nodes with extracted refs get an indented `refs:` block listing
   * each ref by its Aa/Ab/Ba productId, followed by experience/depth/
   * sentiment and numbered quotes. PLAN nodes without refs render the
   * body line only — they remain conversational scaffolding the labeling
   * LLM can read but won't label. CONTEXT nodes render exactly as in
   * `buildCommentsSection`.
   */
  buildLabelingTree(
    subtree: Subtree,
    context: ThreadContext,
    commentLabelMap: Map<string, string>,
  ): string {
    const lines: string[] = [];

    const authorCount = new Map<string, number>();
    for (const node of subtree.nodes) {
      const aid = node.comment.authorId;
      if (aid) authorCount.set(aid, (authorCount.get(aid) ?? 0) + 1);
    }

    for (const node of subtree.nodes) {
      const { comment, nodeType, depth } = node;
      const indent = "  ".repeat(depth);

      if (
        comment.status === CommentStatus.DELETED &&
        this.isContentSafetyDeletion(comment)
      ) {
        lines.push(`${indent}[EXCLUDED]`);
        continue;
      }

      const { authorLabel, ownsLabel } = this.buildAuthorAnnotations(
        comment,
        authorCount,
        context,
      );

      if (nodeType === "CONTEXT") {
        const productsStr = this.buildContextProductAnnotation(comment);
        lines.push(
          `${indent}[CONTEXT] [d:${depth}] ${authorLabel}${ownsLabel}: "${comment.body}"${productsStr}`,
        );
        continue;
      }

      const mediaContent = resolveMediaContent(comment.media);
      const bodyText = mediaContent
        ? `${comment.body}\n${mediaContent}`
        : comment.body;

      const commentLabel = commentLabelMap.get(comment.id);
      const labelTag = commentLabel ? `${commentLabel} ` : "";
      lines.push(
        `${indent}[PLAN] ${labelTag}[d:${depth}] ${authorLabel}${ownsLabel}: "${bodyText}"`,
      );

      const refs = (comment.productReferences ?? []).filter(
        (ref) => ref.quotes?.length,
      );
      if (refs.length === 0 || !commentLabel) continue;

      const refIndent = "  ".repeat(depth + 1);
      lines.push(`${refIndent}refs:`);

      const refDetailIndent = "  ".repeat(depth + 2);
      for (let productIndex = 0; productIndex < refs.length; productIndex++) {
        const ref = refs[productIndex];
        const productLabel = String.fromCharCode(97 + productIndex);
        const productId = `${commentLabel}${productLabel}`;
        const productName = this.formatRefName(ref);
        const knownSpecs = this.formatRefKnownSpecs(ref);

        lines.push(
          `${refDetailIndent}[${productId}] ${productName}${knownSpecs ? ` (known specs: ${knownSpecs})` : ""}`,
        );
        lines.push(
          `${refDetailIndent}  experience: ${ref.experience ?? "reference"}, depth: ${ref.depth ?? "superficial"}, sentiment: ${ref.sentiment ?? "neutral"}`,
        );

        for (
          let quoteIndex = 0;
          quoteIndex < (ref.quotes ?? []).length;
          quoteIndex++
        ) {
          const quote = ref.quotes![quoteIndex];
          lines.push(
            `${refDetailIndent}  q${quoteIndex}: "${quote.text}" [${quote.sentiment}]`,
          );
        }
      }
    }

    return lines.join("\n");
  }

  // ─── Comment Section Rendering ─────────────────────────────────────────────

  /** Build the DFS-ordered [PLAN]/[CONTEXT] comment section for extraction. */
  buildCommentsSection(
    subtree: Subtree,
    context: ThreadContext,
    options?: CommentsSectionOptions,
  ): string {
    const lines: string[] = [];
    const planProductAnnotations = options?.planProductAnnotations;
    const stripContext = options?.stripContext ?? false;

    // Pre-compute author display: show @authorName when ≥2 nodes share authorId OR author has affinity
    const authorCount = new Map<string, number>();
    for (const node of subtree.nodes) {
      const aid = node.comment.authorId;
      if (aid) authorCount.set(aid, (authorCount.get(aid) ?? 0) + 1);
    }

    let planIndex = 0;

    for (const node of subtree.nodes) {
      const { comment, nodeType, depth } = node;
      const indent = "  ".repeat(depth);

      // Content-safety-deleted → [EXCLUDED] placeholder
      if (
        comment.status === CommentStatus.DELETED &&
        this.isContentSafetyDeletion(comment)
      ) {
        if (!stripContext) lines.push(`${indent}[EXCLUDED]`);
        continue;
      }

      const { authorLabel, ownsLabel } = this.buildAuthorAnnotations(
        comment,
        authorCount,
        context,
      );

      if (nodeType === "CONTEXT") {
        if (stripContext) continue;
        const productsStr = this.buildContextProductAnnotation(comment);
        lines.push(
          `${indent}[CONTEXT] [d:${depth}] ${authorLabel}${ownsLabel}: "${comment.body}"${productsStr}`,
        );
        continue;
      }

      // PLAN node — append analyzed media content if available
      const shortId = `c${planIndex++}`;
      const mediaContent = resolveMediaContent(comment.media);
      const bodyText = mediaContent
        ? `${comment.body}\n${mediaContent}`
        : comment.body;

      // Append product annotations from mapping step if available
      const productsAnnotation = this.buildPlanProductAnnotation(
        comment.id,
        planProductAnnotations,
        comment,
      );
      lines.push(
        `${indent}[PLAN] ${shortId} [d:${depth}] ${authorLabel}${ownsLabel}: "${bodyText}"${productsAnnotation}`,
      );
    }

    return lines.join("\n");
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /** Build the shared user prompt with cheat sheet, OP, and comments section. */
  private buildUserPrompt(
    context: ThreadContext,
    commentsSection: string,
    isOpSubtree = false,
    resolvedProductsSection?: string,
    options?: {
      includeCheatSheet?: boolean;
      discoveredProductsSection?: string;
    },
  ): string {
    const parts: string[] = [];
    const includeCheatSheet = options?.includeCheatSheet ?? true;

    if (context.subreddit) {
      parts.push(`## Thread context:\nSubreddit: ${context.subreddit}`);
    }

    // OP section first — stable across subtrees, extends the prefix-cache window.
    // For the OP subtree the full OP body is already in the comments section as a [PLAN] node.
    // For all other subtrees, use the opSection (summary if long, raw body otherwise).
    if (!isOpSubtree && context.opSection) {
      parts.push(`## OP:\n${context.opSection}`);
    }

    if (includeCheatSheet && context.cheatSheetString) {
      parts.push(
        `## Products identified in this thread (each line shows the catalog model under its brand):\n${context.cheatSheetString}`,
      );
    }

    // Resolved products section (for extraction — shows per-comment product details with real specs).
    // Per-subtree, goes after the cheat sheet.
    if (resolvedProductsSection) {
      parts.push(
        `## Resolved products in this subtree:\n${resolvedProductsSection}`,
      );
    }

    // Discovered+resolved distinct products (for pass-1 comment identification —
    // keyed by discovery letter so the model maps each comment to a letter).
    if (options?.discoveredProductsSection) {
      parts.push(
        `## Resolved products (reference each comment to a letter):\n${options.discoveredProductsSection}`,
      );
    }

    parts.push(`## Comments to process:\n${commentsSection}`);

    return parts.join("\n\n");
  }

  // ─── Resolved Products Section ──────────────────────────────────────────────

  /**
   * Build the resolved products section for the extraction prompt.
   * Shows per-comment resolved products with real specs from the DB.
   * Format:
   *   c0: [p0] Acer Predator X34 X5 (34" QD-OLED, 240Hz, USB-C 90W)
   *   c2: [p0] MSI MPG 341CQPX (34" QD-OLED, 240Hz), [p1] Acer Predator X34 X5
   *   c3: [p0] Dell U3425U [unresolved]
   */
  buildResolvedProductsSection(subtree: Subtree): string {
    const lines: string[] = [];

    for (let i = 0; i < subtree.planNodes.length; i++) {
      const node = subtree.planNodes[i];
      const refs = node.comment.productReferences ?? [];
      if (refs.length === 0) continue;

      const productParts = refs.map((ref, refIndex) => {
        const resolvedModel = getPrimaryModel(ref);
        const name =
          resolvedModel?.displayName ??
          `${ref.context?.identification?.brand ?? ""} ${ref.context?.identification?.model ?? ""}`.trim() ??
          "Unknown";
        const resolved = resolvedModel != null;
        const orderedSpecs = this.productSpecContext.getExtractionOrderedSpecs(
          resolvedModel?.orderedSpecs,
          ref.productCategory,
        );
        const specsStr =
          resolved && orderedSpecs.length
            ? ` (${orderedSpecs.map((s) => s.value).join(", ")})`
            : "";
        const unresolvedTag = !resolved ? " [unresolved]" : "";
        return `[p${refIndex}] ${name}${specsStr}${unresolvedTag}`;
      });

      lines.push(`c${i}: ${productParts.join(", ")}`);
    }

    return lines.join("\n");
  }

  /** Build author label and ownership annotation for a node. */
  private buildAuthorAnnotations(
    comment: UserComment,
    authorCount: Map<string, number>,
    context: ThreadContext,
  ): { authorLabel: string; ownsLabel: string } {
    const showAuthor =
      (comment.authorId
        ? (authorCount.get(comment.authorId) ?? 0) >= 2
        : false) || context.getAuthorAffinity(comment.authorId).length > 0;

    const authorLabel = showAuthor
      ? `@${comment.authorName ?? "unknown"} `
      : "";
    const affinity = context.getAuthorAffinity(comment.authorId);
    const ownsLabel = formatAffinityLabel(affinity);

    return { authorLabel, ownsLabel };
  }

  /**
   * Build [products: ...] annotation for PLAN nodes.
   * Uses resolved product names with p-index references when ProductReferences exist,
   * otherwise falls back to mapping annotations.
   */
  private buildPlanProductAnnotation(
    commentId: string,
    planProductAnnotations?: Map<string, LLMMappedProduct[]>,
    comment?: UserComment,
  ): string {
    // Prefer resolved ProductReferences (available after createReferencesFromMapping + resolution)
    const refs = comment?.productReferences ?? [];
    if (refs.length > 0) {
      const names = refs.map((ref, index) => {
        const displayName =
          getPrimaryModel(ref)?.displayName ??
          `${ref.context?.identification?.brand ?? ""} ${ref.context?.identification?.model ?? ""}`.trim();
        return `${displayName} (p${index})`;
      });
      return ` [products: ${names.join(", ")}]`;
    }

    // Fallback to mapping annotations (for backward compatibility)
    if (!planProductAnnotations) return "";
    const products = planProductAnnotations.get(commentId);
    if (!products || products.length === 0) return "";
    const names = products.map((p) => `${p.brand} ${p.model}`.trim());
    return ` [products: ${names.join(", ")}]`;
  }

  /**
   * Build [products: Brand Model, ...] annotation for CONTEXT nodes.
   * Uses enabled ProductReferences from the comment.
   */
  private buildContextProductAnnotation(comment: UserComment): string {
    const refs = comment.productReferences?.filter((r) => r.enabled) ?? [];
    if (refs.length === 0) return "";

    const names = refs.map((r) => {
      const brand = r.context?.identification?.brand ?? "";
      const model = r.context?.identification?.model ?? "";
      return `${brand} ${model}`.trim();
    });

    return ` [products: ${names.join(", ")}]`;
  }

  /**
   * Format a labeling-ref display name: "Brand Model" from resolved model
   * or context.identification, falling back to "Unknown".
   */
  private formatRefName(ref: ProductReference): string {
    const resolved = getPrimaryModel(ref);
    if (resolved) {
      return `${resolved.brand?.name ?? ""} ${resolved.model ?? ""}`.trim();
    }
    if (ref.context?.identification?.brand) {
      return `${ref.context.identification.brand} ${ref.context.identification.model ?? ""}`.trim();
    }
    return "Unknown";
  }

  /**
   * Format the resolved-model orderedSpecs as a comma-separated key=value
   * list, matching what the previous standalone labeling prompt emitted.
   */
  private formatRefKnownSpecs(ref: ProductReference): string {
    return (
      getPrimaryModel(ref)
        ?.orderedSpecs?.map((s) => `${s.key}=${s.value}`)
        .join(", ") ?? ""
    );
  }

  /**
   * Detect content-safety-deleted comments.
   * Only treat a DELETED comment as content-safety-deleted when any
   * moderation entry explicitly contains moderation/safety signals.
   */
  private isContentSafetyDeletion(comment: UserComment): boolean {
    if (comment.status !== CommentStatus.DELETED) {
      return false;
    }

    const reviewComments = (comment.moderations ?? [])
      .map((m) => m.reviewComment ?? "")
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!reviewComments) {
      return false;
    }

    return /\b(content safety|moderation|policy|abuse|abusive|offensive|hate|threat|harass|spam|nsfw|doxx|toxic|violence)\b/.test(
      reviewComments,
    );
  }
}

// ─── Standalone Helpers ──────────────────────────────────────────────────────

function formatAffinityLabel(affinity: AuthorAffinityEntry[]): string {
  if (affinity.length === 0) return "";

  const owns = affinity
    .filter((a) => a.experience === ExperienceType.Owner)
    .map((a) => a.product.displayName);
  const used = affinity
    .filter(
      (a) =>
        a.experience === ExperienceType.PriorOwner ||
        a.experience === ExperienceType.Tested,
    )
    .map((a) => a.product.displayName);

  const parts: string[] = [];
  if (owns.length > 0) parts.push(`owns: ${owns.join(", ")}`);
  if (used.length > 0) parts.push(`used: ${used.join(", ")}`);
  return parts.length > 0 ? `[${parts.join(" · ")}] ` : "";
}
