import { Module } from "@nestjs/common";
import { ExaSearchService } from "./services/exa-search.service";
import { ExaConfigService } from "@ebike-backend/config";

@Module({
  providers: [ExaConfigService, ExaSearchService],
  exports: [ExaSearchService],
})
export class ExaModule {}
