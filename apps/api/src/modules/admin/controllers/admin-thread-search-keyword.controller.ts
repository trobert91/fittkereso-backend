import {
  Body,
  Controller,
  Post,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import { UserRole } from "@ebike-backend/database";
import {
  ThreadSearchKeywordSearchParams,
  ThreadSearchKeywordSearchResult,
  ThreadSearchKeywordSearchService,
} from "@ebike-backend/search";
import { SerializeGroup } from "@ebike-backend/utils";

@Controller("admin-thread-search-keyword")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminThreadSearchKeywordController {
  constructor(
    private readonly searchService: ThreadSearchKeywordSearchService,
  ) {}

  @Post("search")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchThreadSearchKeywords(
    @Body() searchParams: ThreadSearchKeywordSearchParams,
  ): Promise<ThreadSearchKeywordSearchResult> {
    return this.searchService.search(searchParams);
  }
}
