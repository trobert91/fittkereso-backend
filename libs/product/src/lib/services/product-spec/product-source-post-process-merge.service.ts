import { Injectable } from '@nestjs/common';
import { defaults } from 'lodash';
import type { ProductSpecs } from '@fittkereso-backend/database';
import type {
  DeterministicProductData,
  LlmProductContribution,
} from './product-source-post-process.service';

export interface MergedProductData {
  brand: string;
  model: string;
  specs: ProductSpecs;
  releaseYear?: number;
}

/**
 * Merges a source's deterministic extraction (SpecExtractionService +
 * dedicated brand/model/releaseYear scrape-op pipelines) with the optional
 * LLM post-process contribution (ProductSourcePostProcessService), per
 * field: the LLM's value wins wherever it provided one, deterministic fills
 * every gap. `llm` is `undefined` whenever post-processing was skipped,
 * disabled, or failed — merge() degrades to pure-deterministic pass-through
 * in that case with no special-casing needed by callers.
 */
@Injectable()
export class ProductSourcePostProcessMergeService {
  merge(
    deterministic: DeterministicProductData,
    llm: LlmProductContribution | undefined,
  ): MergedProductData {
    return {
      // llm.brand/llm.model are pre-sanitized (trimmed, blank -> undefined)
      // by ProductSourcePostProcessService before this is called.
      brand: llm?.brand || deterministic.brand,
      model: llm?.model || deterministic.model,
      // defaults() fills only keys still `undefined` in the target, so specs
      // from `llm` (applied first) are never overwritten by deterministic —
      // this is a shallow, whole-value-wins merge: array-type spec values
      // are replaced wholesale, never element-merged (unlike defaultsDeep).
      specs: defaults({}, llm?.specs, deterministic.specs),
      releaseYear: llm?.releaseYear ?? deterministic.releaseYear,
    };
  }
}
