import { Injectable } from '@nestjs/common';
import { defaults } from 'lodash';
import type { ProductSpecs } from '@fittkereso-backend/database';
import type {
  DeterministicProductData,
  IdentityContribution,
  ModelSpecContribution,
} from './product-source-post-process.service';

export interface MergedProductData {
  brand: string;
  model: string;
  specs: ProductSpecs;
  /**
   * Whether `model` came from the identity extraction rather than being the
   * raw title passed through — see ScrapedProduct.nameCleaned.
   */
  nameCleaned: boolean;
}

/**
 * Merges a source's deterministic extraction (SpecExtractionService +
 * dedicated brand/model scrape-op pipelines) with the two
 * optional LLM post-process contributions
 * (ProductSourcePostProcessService.extractIdentity/processModelSpecs),
 * per field: an LLM's value wins wherever it provided one, deterministic
 * fills every gap. Either or both LLM contributions may be `undefined`
 * whenever their pass was skipped, disabled, or failed — merge() degrades
 * gracefully with no special-casing needed by callers.
 */
@Injectable()
export class ProductSourcePostProcessMergeService {
  merge(
    deterministic: DeterministicProductData,
    identity: IdentityContribution | undefined,
    modelSpecs: ModelSpecContribution | undefined,
  ): MergedProductData {
    // The identity and unification contributions target disjoint key sets by
    // construction (each call's response schema holds only its own fields),
    // so the spread order between them never actually collides in practice.
    const llmSpecs = { ...modelSpecs?.specs, ...identity?.specs };

    return {
      // identity.brand/model are pre-sanitized (trimmed, blank -> undefined)
      // by ProductSourcePostProcessService before this is called.
      brand: identity?.brand || deterministic.brand,
      model: identity?.model || deterministic.model,
      nameCleaned: !!identity?.model,
      // defaults() fills only keys still `undefined` in the target, so LLM
      // specs (applied first) are never overwritten by deterministic — this
      // is a shallow, whole-value-wins merge: array-type spec values are
      // replaced wholesale, never element-merged (unlike defaultsDeep).
      specs: defaults({}, llmSpecs, deterministic.specs),
    };
  }
}
