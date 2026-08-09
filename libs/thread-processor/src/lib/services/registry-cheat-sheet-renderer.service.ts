import { Injectable } from "@nestjs/common";
import { Depth } from "@ebike-backend/database";
import {
  ProductRegistryEntry,
  RegistryOptions,
} from "../models/product-registry.model";
import { ThreadContext } from "../models/thread-context";
import {
  DEPTH_RANK,
  RECENCY_RANK,
  capitalize,
} from "./registry-rank.constants";

type DetailLevel = "full" | "compact";

/**
 * Renders the in-memory product registry into the "cheat sheet" text block that
 * is injected into extraction/validation prompts. A pure read over registry
 * state — entry specs are precomputed during registry building, so the renderer
 * has no dependencies (build/dedup is owned by ProductRegistryService).
 */
@Injectable()
export class RegistryCheatSheetRenderer {
  /**
   * Select the highest-priority registry entries that fit the prompt budget and
   * render them as the cheat-sheet string. Caller is responsible for any registry
   * mutation (e.g. dedup) before calling — this method only reads.
   */
  render(context: ThreadContext, opts: RegistryOptions): string {
    const {
      maxProducts,
      maxOpSlots,
      maxChars,
      lowRefThreshold,
      minSlotsPerCategory,
    } = opts;
    const registry = Array.from(context.productRegistry.values());

    // Step 1: Filter — drop ineligible 'earlier' entries
    const eligible = registry.filter(
      (e) => e.recency !== "earlier" || e.referenceCount >= lowRefThreshold,
    );

    // Step 2: Per-category minimum guarantee
    const byCategory = groupByCategory(eligible);
    const selected = new Set<ProductRegistryEntry>();

    for (const entries of byCategory.values()) {
      const sorted = sortForCategoryGuarantee(entries);
      let guaranteedForCategory = 0;
      for (const entry of sorted) {
        if (selected.size >= maxProducts) break;
        if (guaranteedForCategory >= minSlotsPerCategory) break;
        selected.add(entry);
        guaranteedForCategory++;
      }
    }

    // Step 3: Apply maxOpSlots cap across all guaranteed OP entries
    const selectedOpEntries = [...selected].filter((e) => e.inOp);
    if (selectedOpEntries.length > maxOpSlots) {
      const opToRemove = [...selectedOpEntries]
        .sort(lowestPriorityFirst)
        .slice(0, selectedOpEntries.length - maxOpSlots);
      for (const entry of opToRemove) selected.delete(entry);
    }

    // Step 4: Fill remaining slots using global priority
    const globalPool = eligible
      .filter((e) => !selected.has(e))
      .sort((a, b) => {
        const rankDiff = RECENCY_RANK[a.recency] - RECENCY_RANK[b.recency];
        if (rankDiff !== 0) return rankDiff;
        return b.referenceCount - a.referenceCount;
      });

    for (const entry of globalPool) {
      if (selected.size >= maxProducts) break;
      selected.add(entry);
    }

    // Step 5: Assign detail level and mentionedAs visibility
    const detailMap = new Map<ProductRegistryEntry, DetailLevel>();
    const showMentionedAs = new Map<ProductRegistryEntry, boolean>();

    for (const entry of selected) {
      detailMap.set(
        entry,
        entry.recency === "in_op" || entry.recency === "latest"
          ? "full"
          : "compact",
      );
      showMentionedAs.set(entry, (entry.mentionedAs?.length ?? 0) > 0);
    }

    // Step 6: Format
    let promptProducts = [...selected];
    let rendered = this.formatByCategory(
      promptProducts,
      detailMap,
      showMentionedAs,
    );

    // Step 7: Size cap — strip mentionedAs from compact entries first, then drop entries
    while (rendered.length > maxChars) {
      // Phase A: strip mentionedAs from the lowest-priority compact entry that still has them
      const compactWithAliases = promptProducts.filter(
        (e) =>
          detailMap.get(e) === "compact" && showMentionedAs.get(e) === true,
      );
      if (compactWithAliases.length > 0) {
        const victim = [...compactWithAliases].sort(lowestPriorityFirst)[0];
        showMentionedAs.set(victim, false);
        rendered = this.formatByCategory(
          promptProducts,
          detailMap,
          showMentionedAs,
        );
        continue;
      }

      // Phase B: drop the lowest-priority compact entry
      const compactEntries = promptProducts.filter(
        (e) => detailMap.get(e) === "compact",
      );
      if (compactEntries.length === 0) break;

      const victim = [...compactEntries].sort(lowestPriorityFirst)[0];
      promptProducts = promptProducts.filter((e) => e !== victim);
      detailMap.delete(victim);
      showMentionedAs.delete(victim);
      rendered = this.formatByCategory(
        promptProducts,
        detailMap,
        showMentionedAs,
      );
    }

    return rendered;
  }

  private formatByCategory(
    entries: ProductRegistryEntry[],
    detailMap: Map<ProductRegistryEntry, DetailLevel>,
    showMentionedAs: Map<ProductRegistryEntry, boolean>,
  ): string {
    // Group by category, then by brand within category
    const byCategoryAndBrand = new Map<
      string,
      Map<string, ProductRegistryEntry[]>
    >();

    for (const entry of entries) {
      const category = entry.category ?? "";
      let brandMap = byCategoryAndBrand.get(category);
      if (!brandMap) {
        brandMap = new Map();
        byCategoryAndBrand.set(category, brandMap);
      }
      const group = brandMap.get(entry.brand) ?? [];
      group.push(entry);
      brandMap.set(entry.brand, group);
    }

    const lines: string[] = [];

    const namedCategories = [...byCategoryAndBrand.keys()]
      .filter((c) => c)
      .sort();
    const uncategorized = byCategoryAndBrand.get("");

    for (const category of namedCategories) {
      lines.push(`── ${capitalize(category)} ──`);
      const brandMap = byCategoryAndBrand.get(category)!;
      this.renderBrandGroups(brandMap, lines, detailMap, showMentionedAs);
    }

    if (uncategorized && uncategorized.size > 0) {
      if (namedCategories.length > 0) lines.push("── Other ──");
      this.renderBrandGroups(uncategorized, lines, detailMap, showMentionedAs);
    }

    return lines.join("\n");
  }

  private renderBrandGroups(
    brandMap: Map<string, ProductRegistryEntry[]>,
    lines: string[],
    detailMap: Map<ProductRegistryEntry, DetailLevel>,
    showMentionedAs: Map<ProductRegistryEntry, boolean>,
  ): void {
    const sortedBrands = [...brandMap.keys()].sort();

    for (const brand of sortedBrands) {
      const group = brandMap.get(brand)!;
      lines.push(`${capitalize(brand)}:`);

      // Alphabetical sort by the token we will print — stable across subtrees so
      // OpenAI's prefix cache is not invalidated by per-subtree recency shifts.
      group.sort((a, b) => {
        const an = (
          a.resolvedProduct?.model ??
          a.extractedName ??
          a.displayName ??
          ""
        ).toLowerCase();
        const bn = (
          b.resolvedProduct?.model ??
          b.extractedName ??
          b.displayName ??
          ""
        ).toLowerCase();
        return an.localeCompare(bn);
      });

      for (const entry of group) {
        const contextTag = this.formatContextTag(entry);
        const detail = detailMap.get(entry) ?? "compact";
        const mentionedTag =
          showMentionedAs.get(entry) && entry.mentionedAs?.length
            ? ` (mentioned as: ${entry.mentionedAs.map((s) => `"${s}"`).join(", ")})`
            : "";

        if (entry.resolvedProduct) {
          const bulletToken = entry.resolvedProduct.model;
          if (detail === "full") {
            const specPart = entry.specs?.trim() ? ` — ${entry.specs}` : "";
            lines.push(
              `  - ${bulletToken}${specPart}  ${contextTag}${mentionedTag}`,
            );
          } else {
            lines.push(`  - ${bulletToken}  ${contextTag}${mentionedTag}`);
          }
        } else {
          const nameForPrompt = entry.extractedName ?? entry.displayName;
          lines.push(
            `  - ${nameForPrompt} (unresolved)  ${contextTag}${mentionedTag}`,
          );
        }
      }
    }
  }

  private formatContextTag(entry: ProductRegistryEntry): string {
    // Recency is intentionally excluded — it changes every subtree and churns the
    // prompt prefix cache without giving the model a load-bearing signal. Importance
    // (primary/secondary/mentioned) is the only tag kept.
    const importance =
      DEPTH_RANK[entry.maxDepth] >= DEPTH_RANK[Depth.Detailed]
        ? "primary"
        : entry.maxDepth === Depth.Mentioned
          ? "secondary"
          : "mentioned";

    return `[${importance}]`;
  }
}

// ─── Render-only helpers ─────────────────────────────────────────────────────

/**
 * Sort entries within a category for the per-category slot guarantee:
 * inOp first, then maxDepth desc, then referenceCount desc.
 */
function sortForCategoryGuarantee(
  entries: ProductRegistryEntry[],
): ProductRegistryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.inOp !== b.inOp) return a.inOp ? -1 : 1;
    const depthDiff = DEPTH_RANK[b.maxDepth] - DEPTH_RANK[a.maxDepth];
    if (depthDiff !== 0) return depthDiff;
    return b.referenceCount - a.referenceCount;
  });
}

/** Group entries by category. Entries without a category use the empty string key. */
function groupByCategory(
  entries: ProductRegistryEntry[],
): Map<string, ProductRegistryEntry[]> {
  const groups = new Map<string, ProductRegistryEntry[]>();
  for (const entry of entries) {
    const category = entry.category ?? "";
    const group = groups.get(category) ?? [];
    group.push(entry);
    groups.set(category, group);
  }
  return groups;
}

/** Comparator for dropping lowest-priority compact entries. */
function lowestPriorityFirst(
  a: ProductRegistryEntry,
  b: ProductRegistryEntry,
): number {
  const depthDiff = DEPTH_RANK[a.maxDepth] - DEPTH_RANK[b.maxDepth];
  if (depthDiff !== 0) return depthDiff;
  if (a.referenceCount !== b.referenceCount)
    return a.referenceCount - b.referenceCount;
  return RECENCY_RANK[b.recency] - RECENCY_RANK[a.recency];
}
