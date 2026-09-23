import { ProductSpecs } from '@fittkereso-backend/database';
import { filterDefinedSpecs, hashSpecs } from '@fittkereso-backend/utils';
import { omit, pick } from 'lodash';

/**
 * The deterministic spec mapping, split into its two halves and hashed.
 *
 * The two halves are disjoint by construction, which is the point: an
 * offer-level-only difference between sibling variants (a different frameSize,
 * say) must never invalidate the expensive, shared product-identity half.
 */
export interface SplitDeterministicSpecs {
  offerLevelDeterministicSpecs: ProductSpecs;
  productLevelDeterministicSpecs: ProductSpecs;
  offerSpecsHash: string;
  productSpecsHash: string;
}

/**
 * Split a deterministic spec mapping by offer-level keys and hash each half.
 *
 * Shared by every importer rather than inlined per path, because these hashes
 * ARE the cost control — they are what skips the two LLM post-process calls on
 * an unchanged product — and two implementations of them would eventually
 * disagree about which keys or which filtering went into a hash, silently
 * defeating the cache for one path.
 *
 * `filterDefinedSpecs` runs before hashing so that hashing, the LLM calls'
 * input and persistence all see exactly the same object. Without it a key a
 * normalization pass mapped but could not type-convert (present, valued
 * `undefined`) made two byte-identical spec objects hash differently depending
 * on when in the pipeline they were hashed.
 */
export function splitDeterministicSpecs(
  specs: ProductSpecs,
  offerLevelKeys: string[],
): SplitDeterministicSpecs {
  const offerLevelDeterministicSpecs = filterDefinedSpecs(
    pick(specs, offerLevelKeys),
  );
  const productLevelDeterministicSpecs = filterDefinedSpecs(
    omit(specs, offerLevelKeys),
  );

  return {
    offerLevelDeterministicSpecs,
    productLevelDeterministicSpecs,
    offerSpecsHash: hashSpecs(offerLevelDeterministicSpecs),
    productSpecsHash: hashSpecs(productLevelDeterministicSpecs),
  };
}
