import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { EmailModule } from '@fittkereso-backend/email';
import { ProductModule } from '@fittkereso-backend/product';
import {
  CategoryConfigService,
  RecaptchaConfigService,
} from '@fittkereso-backend/config';
import { PublicProductsController } from './controllers/public-products.controller';
import { PublicCategoriesController } from './controllers/public-categories.controller';
import { PublicSearchController } from './controllers/public-search.controller';
import { PublicContactController } from './controllers/public-contact.controller';
import { PublicProductsService } from './services/public-products.service';
import { PublicCategoriesService } from './services/public-categories.service';
import { PublicAutocompleteService } from './services/public-autocomplete.service';
import { PublicSearchService } from './services/public-search.service';
import { SearchAnalyticsService } from './services/search-analytics.service';
import { RecaptchaService } from './services/recaptcha.service';
import { PublicContactService } from './services/public-contact.service';

@Module({
  imports: [DatabaseModule, DynamicConfigModule, EmailModule, ProductModule],
  controllers: [
    PublicProductsController,
    PublicCategoriesController,
    PublicSearchController,
    PublicContactController,
  ],
  providers: [
    CategoryConfigService,
    RecaptchaConfigService,
    PublicProductsService,
    PublicCategoriesService,
    PublicAutocompleteService,
    PublicSearchService,
    SearchAnalyticsService,
    RecaptchaService,
    PublicContactService,
  ],
})
export class PublicModule {}
