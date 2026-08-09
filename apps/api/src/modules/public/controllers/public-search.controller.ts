import { Controller, Get, Query, SerializeOptions } from "@nestjs/common";
import { SerializeGroup } from "@ebike-backend/utils";
import { PublicAutocompleteService } from "../services/public-autocomplete.service";
import { PublicSearchService } from "../services/public-search.service";
import { SearchAnalyticsService } from "../services/search-analytics.service";
import {
  AutocompleteResultDto,
  SearchResultDto,
  SearchQueryDto,
} from "../dto/search.dto";
import { SkipThrottle } from "@nestjs/throttler";

@Controller("v1/public/search")
@SkipThrottle()
@SerializeOptions({ groups: [SerializeGroup.list, SerializeGroup.details] })
export class PublicSearchController {
  constructor(
    private readonly autocompleteService: PublicAutocompleteService,
    private readonly searchService: PublicSearchService,
    private readonly analyticsService: SearchAnalyticsService,
  ) {}

  @Get("autocomplete")
  async autocomplete(@Query("q") q: string): Promise<AutocompleteResultDto> {
    const start = Date.now();
    const result = await this.autocompleteService.autocomplete(q ?? "");
    this.analyticsService.logSearchEvent({
      endpoint: "autocomplete",
      query: q ?? "",
      resultCount: result.products.length + result.categories.length,
      hasProductResults: result.products.length > 0,
      hasCategoryResults: result.categories.length > 0,
      durationMs: Date.now() - start,
    });
    return result;
  }

  @Get()
  @SkipThrottle()
  async fullSearch(@Query() query: SearchQueryDto): Promise<SearchResultDto> {
    const start = Date.now();
    const result = await this.searchService.search(
      query.q,
      query.page ?? 1,
      query.pageSize ?? 20,
    );
    this.analyticsService.logSearchEvent({
      endpoint: "full",
      query: query.q,
      resultCount: result.products.length + result.categories.length,
      hasProductResults: result.products.length > 0,
      hasCategoryResults: result.categories.length > 0,
      durationMs: Date.now() - start,
    });
    return result;
  }
}
