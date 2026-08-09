import type {
  ContentQuality,
  ProductResolutionCategory,
  RelevanceFactors,
  StructuredSpec,
} from './product-resolution-context';
import type { ValidationIssue } from './validation-issue';

export interface ProductReferenceContext {
  // Phase 1d Identification — snapshot of what the LLM identification step
  // extracted. Populated both from the identification flow and the
  // discovered-product flow.
  identification: {
    /**
     * `explicit` = new identification (or info that may disambiguate an
     * ambiguous parent — resolver should run fresh on a registry hit).
     * `referenced` = back-reference to a product already mentioned earlier in
     * the thread (registry-hit candidate set is copied verbatim).
     */
    type?: 'explicit' | 'referenced';
    brand?: string;
    model?: string;
    displayName?: string;
    registryKey?: string;
    contentQuality?: ContentQuality;
    categoryHint?: string;
    categories?: string[];
    specs?: StructuredSpec[];
    searchBefore?: Date;
    referenceModel?: string;
    modelClues?: string[];
    variantClues?: string[];
    /** Raw same-product group letter the identification LLM emitted (the `linkId`
     *  field — "A", "B", …). Kept for trace/audit; the runtime grouping primitive
     *  is the persisted `ProductReference.productLinkId` UUID derived from it. */
    productLinkLabel?: string;
  };

  // Phase 3 Resolution — state produced by the resolution flow.
  resolution: {
    // Categories already matched at identification time (from ref.productCategory);
    // tells the search agent to skip its own category-similarity step.
    preResolvedCategories?: ProductResolutionCategory[];
    // Specs the enricher added from ancestors/descendants/affinity (debug-only).
    enrichedSpecs?: StructuredSpec[];
    // Flags refs whose resolved product changed during Phase 4b re-resolution (debug-only).
    resolutionRetriggered?: boolean;
  };

  // Phase 4 Extraction — fields produced by subtree-extraction.
  extraction?: {
    // True when extraction found specs identification missed. Gates the
    // post-extraction re-resolution call at subtree-processor.service.ts:424;
    // read at :650, cleared at :699.
    newSpecsDiscovered?: boolean;
    // Specs the extraction LLM pulled from the comment body (debug-only).
    specs?: StructuredSpec[];
  };

  /** Validation issues detected on this ref (deterministic + LLM, merged).
   *  One entry per type — LLM overrides deterministic for authority: 'both' types. */
  issues?: ValidationIssue[];

  // Phase 6 Relevance — diagnostic factor breakdown.
  relevance?: {
    factors: RelevanceFactors;
  };
}
