import { Module } from "@nestjs/common";
import { DatabaseModule } from "@ebike-backend/database";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { EmailModule } from "@ebike-backend/email";
import { ProductModule } from "@ebike-backend/product";
import {
  CategoryConfigService,
  RecaptchaConfigService,
} from "@ebike-backend/config";
import { PublicProductsController } from "./controllers/public-products.controller";
import { PublicCategoriesController } from "./controllers/public-categories.controller";
import { PublicSearchController } from "./controllers/public-search.controller";
import { PublicContactController } from "./controllers/public-contact.controller";
import { PublicReviewsController } from "./controllers/public-reviews.controller";
import { PublicProductsService } from "./services/public-products.service";
import { PublicCategoriesService } from "./services/public-categories.service";
import { PublicAutocompleteService } from "./services/public-autocomplete.service";
import { PublicSearchService } from "./services/public-search.service";
import { SearchAnalyticsService } from "./services/search-analytics.service";
import { RecaptchaService } from "./services/recaptcha.service";
import { PublicContactService } from "./services/public-contact.service";
import { PublicFeedbackService } from "./services/public-feedback.service";
import { PublicReviewsService } from "./services/public-reviews.service";

@Module({
  imports: [DatabaseModule, DynamicConfigModule, EmailModule, ProductModule],
  controllers: [
    PublicProductsController,
    PublicCategoriesController,
    PublicSearchController,
    PublicContactController,
    PublicReviewsController,
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
    PublicFeedbackService,
    PublicReviewsService,
  ],
})
export class PublicModule {}
