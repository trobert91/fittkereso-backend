import { ProductCategory } from '../postgres';
import { ProductSpecs } from './product-spec';
import type { MatchResultComponents } from './product-search-context';

/** A spec with a typed key and freeform value, as extracted by the LLM. */
export interface StructuredSpec {
  name: string;
  value: string;
}

export type ContentQuality = 'high' | 'medium' | 'low';

/** Returns true when a product reference's identification flagged it as low-quality
 * (product named but not evaluated). Used by the post-identification flow to
 * mark low-only comments as SKIPPED so they bypass extraction/labeling/validation. */
export function isLowQualityRef(ref: {
  context?: { identification?: { contentQuality?: ContentQuality } };
}): boolean {
  return ref.context?.identification?.contentQuality === 'low';
}

export interface ProductReferenceEvaluation {
  referenceId: string;
  relevance: number;
}

export interface MatchCandidateDiagnostics {
  candidateId: string;
  alias: string;
  score: number;
  components: MatchResultComponents;
  yearAdjustment?: {
    inputYear?: number;
    candidateYear?: number;
    scoreDelta: number;
  };
}

export interface MatchDiagnostics {
  normalizedInput?: string;
  inputTokens?: string[];
  criticalAlphaTokens?: string[];
  categoryStrictness?: 'strict' | 'moderate' | 'loose';
  droppedSpecs?: StructuredSpec[];
  bestCandidate?: MatchCandidateDiagnostics;
  secondScore?: number;
  failedGates?: string[];
}

export interface RelevanceFactors {
  depthMultiplier: number;
  quoteQualityMultiplier: number;
  sentimentMultiplier: number;
  experienceMultiplier: number;
  experienceFloorBonus: number;
  featureMultiplier: number;
  useCaseMultiplier: number;
  featureUseCaseMultiplier: number;
  intentMultiplier?: number;
  upvoteBoost?: number;
}

export interface CrossMarketVariant {
  model: string;
  region?: string;
  confidence: number;
}

export interface CrossMarketSearchInfo {
  /** Primary keyword used for the SERP query */
  keyword?: string;
  /** Whether the fallback keyword was used (primary returned no results) */
  usedFallback?: boolean;
  /** Web search provider metadata for the cross-market query */
  webSearch?: {
    keyword?: string;
    provider?: 'dataforseo' | 'exa';
    source?: 'cache' | 'api';
    cacheHit?: boolean;
    cacheEntryId?: string;
  };
  /** Number of SERP results passed to the LLM extractor */
  serpResultCount?: number;
  /** All variants returned by LLM before confidence filtering */
  rawVariants?: CrossMarketVariant[];
  /** Variants that passed the minConfidence threshold, with resolution outcome */
  filteredVariants?: Array<CrossMarketVariant & { resolved: boolean }>;
  /** Why the phase was skipped entirely (if applicable) */
  skippedReason?: 'no_brand' | 'no_model' | 'disabled';
  /** Min confidence threshold applied */
  minConfidence?: number;
  /** Regions searched */
  regions?: string[];
}

export interface ProductResolutionOptions {
  useEmbedding: boolean;
  webSearchEnabled: boolean;
  mode: ProductResolutionMode;
  crossMarketSearchEnabled?: boolean;
  crossMarketSearchMinConfidence?: number;
}

export enum ProductResolutionMode {
  loose = 'loose',
  strict = 'strict',
}

export interface ProductResolutionBrand {
  id: string;
  name: string;
  domains?: string[];
  similarity: number;
}

export interface ProductResolutionCategory {
  id: string;
  name: string;
  similarity: number;
  /** Optional per-category cache tolerance overrides from ProductCategoryConfig. */
  cacheConfig?: {
    pastToleranceDays?: number;
    futureToleranceDays?: number;
  };
}

export interface GoogleSerpResult {
  title: string;
  description: string;
  url: string;
}

export interface ProductData {
  id: string;
  model?: string;
  brand?: string;
  brandId?: string;
  displayName?: string;
  aliases?: string[];
  specs?: ProductSpecs;
  category?: ProductCategory;
  releaseYear?: number;
}

export interface EvaluatedProduct extends ProductData {
  confidence?: number;
  source?: string;
  matchedAlias?: string;
}
