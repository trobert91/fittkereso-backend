import { Module } from '@nestjs/common';
import { AiModule } from '@fittkereso-backend/ai';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductModule } from '@fittkereso-backend/product';
import { CandidateRecallService } from './candidate-recall.service';
import { ListingMatchLlmService } from './listing-match-llm.service';
import { ListingMatchService } from './listing-match.service';
import { ProductCandidateFinderService } from './product-candidate-finder.service';
import { ProductDuplicateScanService } from './product-duplicate-scan.service';
import { ProductDuplicateService } from './product-duplicate.service';
import { ProductMatchQueryService } from './product-match-query.service';
import { TokenIdfService } from './token-idf.service';

/**
 * Product matching and duplicate detection. `CategoryConfigService` comes from
 * each app's global AppConfigModule.
 */
@Module({
  imports: [AiModule, DatabaseModule, ProductModule],
  providers: [
    ProductMatchQueryService,
    CandidateRecallService,
    TokenIdfService,
    ProductCandidateFinderService,
    ListingMatchLlmService,
    ListingMatchService,
    ProductDuplicateService,
    ProductDuplicateScanService,
  ],
  exports: [
    ProductMatchQueryService,
    CandidateRecallService,
    TokenIdfService,
    ProductCandidateFinderService,
    ListingMatchLlmService,
    ListingMatchService,
    ProductDuplicateService,
    ProductDuplicateScanService,
  ],
})
export class ProductIdentityModule {}
