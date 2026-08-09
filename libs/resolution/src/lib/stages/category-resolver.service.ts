import { Injectable } from "@nestjs/common";
import { CategoryNameMatcherService } from "@ebike-backend/product";
import type { ResolutionContext } from "../models/resolution-context";

/**
 * Stage 2 category resolution.
 *
 * Two paths:
 *  1. `input.category.id` is set (caller pre-resolved at extraction time, the
 *     common case when `ref.productCategory` was non-null) → use it directly,
 *     similarity = 1.0.
 *  2. Only `input.category.name` (or just `categoryHint`) is set → fall back to
 *     `CategoryNameMatcherService.matchFromEnabledCategories`. Similarity = 1.0
 *     when matched, otherwise leaves `ctx.category` unset.
 *
 * Skipped when stage 1 already populated `ctx.category` from the reference product.
 */
@Injectable()
export class CategoryResolverService {
  constructor(
    private readonly categoryNameMatcher: CategoryNameMatcherService,
  ) {}

  async resolve(context: ResolutionContext): Promise<void> {
    if (context.category) return;

    const inputCategory = context.input.category;
    if (inputCategory?.id) {
      context.category = {
        id: inputCategory.id,
        name: inputCategory.name,
        similarity: 1.0,
      };
      return;
    }

    const hint = inputCategory?.name ?? context.input.categoryHint;
    if (!hint) return;

    try {
      const matched =
        await this.categoryNameMatcher.matchFromEnabledCategories(hint);
      if (matched) {
        context.category = {
          id: matched.id,
          name: matched.name,
          similarity: 1.0,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      context.errors.push({
        phase: "category_resolution",
        message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
