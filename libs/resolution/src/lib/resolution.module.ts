import { Module } from '@nestjs/common';
import { AiModule } from '@fittkereso-backend/ai';
import { DatabaseModule } from '@fittkereso-backend/database';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { ProductModule } from '@fittkereso-backend/product';
import { CandidateScoringService } from './matching/candidate-scoring.service';
import { InputNormalizationService } from './matching/input-normalization.service';
import { MatchingConfigService } from './matching/matching-config.service';
import { QualityGatesService } from './matching/quality-gates.service';
import { BrandResolverService } from './stages/brand-resolver.service';
import { CategoryResolverService } from './stages/category-resolver.service';
import { DecisionService } from './stages/decision.service';
import { FilterService } from './stages/filter.service';
import { FinalizeService } from './stages/finalize.service';
import { RecallService } from './stages/recall.service';
import { ReferenceProductResolver } from './stages/reference-product-resolver';
import { ScoringService } from './stages/scoring.service';
import { FuzzyRecallStrategy } from './strategies/recall/fuzzy.recall';
import { EmbeddingRecallStrategy } from './strategies/recall/embedding.recall';
import { ModelCatalogSearchService } from './strategies/recall/model-catalog-search.service';
import { WebResearchRecallStrategy } from './strategies/recall/web-research.recall';
import { LlmDecisionStrategy } from './strategies/decision/llm-decision.strategy';
import { CatalogResolver } from './web-search/catalog-resolver';
import { SerpSkusExtractor } from './web-search/serp-skus.extractor';
import { WebSearchKeywordBuilder } from './web-search/web-search-keyword.builder';
import {
  DECISION_STRATEGY,
  RECALL_STRATEGIES,
  type RecallStrategy,
} from './models/strategy-types';
import { ResolutionService } from './resolution.service';

/**
 * `resolution` library module.
 *
 * Wires the `ReferenceProductResolver` and the `ResolutionService` orchestrator.
 * The orchestrator runs the stages sequentially: reference → brand/category →
 * recall → filter → score → decide → finalize.
 *
 * Recall strategy order is significant. Fuzzy → Embedding → Web:
 *  - `EmbeddingRecallStrategy.shouldRun` requires fuzzy's pool to be empty.
 *  - `WebResearchRecallStrategy.shouldRun` (for non-reference search) requires
 *    fuzzy+embedding's pool to be empty.
 *
 * `CategoryConfigService` is provided by the global `AppConfigModule` in each
 * app, so it is not declared here.
 */
@Module({
  imports: [AiModule, DatabaseModule, DynamicConfigModule, ProductModule],
  providers: [
    MatchingConfigService,
    InputNormalizationService,
    QualityGatesService,
    CandidateScoringService,
    ReferenceProductResolver,
    BrandResolverService,
    CategoryResolverService,
    FilterService,
    ScoringService,
    FuzzyRecallStrategy,
    EmbeddingRecallStrategy,
    ModelCatalogSearchService,
    WebSearchKeywordBuilder,
    SerpSkusExtractor,
    CatalogResolver,
    WebResearchRecallStrategy,
    LlmDecisionStrategy,
    {
      provide: RECALL_STRATEGIES,
      inject: [
        FuzzyRecallStrategy,
        EmbeddingRecallStrategy,
        WebResearchRecallStrategy,
      ],
      useFactory: (
        fuzzy: FuzzyRecallStrategy,
        embedding: EmbeddingRecallStrategy,
        web: WebResearchRecallStrategy,
      ): RecallStrategy[] => [fuzzy, embedding, web],
    },
    {
      provide: DECISION_STRATEGY,
      useExisting: LlmDecisionStrategy,
    },
    RecallService,
    DecisionService,
    FinalizeService,
    ResolutionService,
  ],
  exports: [
    MatchingConfigService,
    InputNormalizationService,
    QualityGatesService,
    CandidateScoringService,
    ReferenceProductResolver,
    BrandResolverService,
    CategoryResolverService,
    FilterService,
    ScoringService,
    WebSearchKeywordBuilder,
    SerpSkusExtractor,
    CatalogResolver,
    RecallService,
    DecisionService,
    FinalizeService,
    RECALL_STRATEGIES,
    DECISION_STRATEGY,
    ResolutionService,
  ],
})
export class ResolutionModule {}
