import { Injectable } from '@nestjs/common';
import { defaults } from 'lodash';
import type { ProductSpecs } from '@fittkereso-backend/database';
import type {
  DeterministicProductData,
  ModelSpecContribution,
  OfferIdentityContribution,
} from './product-source-post-process.service';

export interface MergedProductData {
  brand: string;
  model: string;
  specs: ProductSpecs;
  releaseYear?: number;
}

/**
 * Merges a source's deterministic extraction (SpecExtractionService +
 * dedicated brand/model/releaseYear scrape-op pipelines) with the two
 * optional LLM post-process contributions
 * (ProductSourcePostProcessService.processOfferIdentity/processModelSpecs),
 * per field: an LLM's value wins wherever it provided one, deterministic
 * fills every gap. Either or both LLM contributions may be `undefined`
 * whenever their pass was skipped, disabled, or failed — merge() degrades
 * gracefully with no special-casing needed by callers.
 */
@Injectable()
export class ProductSourcePostProcessMergeService {
  merge(
    deterministic: DeterministicProductData,
    offerIdentity: OfferIdentityContribution | undefined,
    modelSpecs: ModelSpecContribution | undefined,
  ): MergedProductData {
    // Offer-level and model-level LLM contributions target disjoint key sets
    // by construction (see ProductSourcePostProcessService), so the spread
    // order between them never actually collides in practice.
    const llmSpecs = { ...modelSpecs?.specs, ...offerIdentity?.specs };

    return {
      // offerIdentity.brand/model are pre-sanitized (trimmed, blank ->
      // undefined) by ProductSourcePostProcessService before this is called.
      brand: offerIdentity?.brand || deterministic.brand,
      model: offerIdentity?.model || deterministic.model,
      // defaults() fills only keys still `undefined` in the target, so LLM
      // specs (applied first) are never overwritten by deterministic — this
      // is a shallow, whole-value-wins merge: array-type spec values are
      // replaced wholesale, never element-merged (unlike defaultsDeep).
      specs: defaults({}, llmSpecs, deterministic.specs),
      releaseYear: offerIdentity?.releaseYear ?? deterministic.releaseYear,
    };
  }
}
