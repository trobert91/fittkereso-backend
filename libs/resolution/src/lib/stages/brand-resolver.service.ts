import { Injectable } from '@nestjs/common';
import { BrandResolutionService } from '@fittkereso-backend/product';
import type { ResolutionContext } from '../models/resolution-context';

/**
 * Stage 2 brand resolution.
 *
 * Resolves `input.brand` (free-text string from the LLM) to a `Brand` entity via
 * trigram search, falling back to `input.displayName` parsing when brand text is
 * missing. Writes `ctx.brand` with similarity.
 *
 * Skipped when stage 1 already populated `ctx.brand` from the reference product.
 */
@Injectable()
export class BrandResolverService {
  constructor(private readonly brandResolution: BrandResolutionService) {}

  async resolve(context: ResolutionContext): Promise<void> {
    if (context.brand) return;

    try {
      const brandResult = await this.brandResolution.resolve(
        context.input.brand,
        context.input.displayName,
      );
      if (brandResult) {
        context.brand = {
          id: brandResult.entity.id,
          name: brandResult.entity.name,
          similarity: brandResult.similarity,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      context.errors.push({
        phase: 'brand_resolution',
        message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
