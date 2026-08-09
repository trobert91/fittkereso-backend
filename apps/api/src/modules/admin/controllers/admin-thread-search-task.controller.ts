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
  ThreadSearchTaskSearchParams,
  ThreadSearchTaskSearchResult,
  ThreadSearchTaskSearchService,
} from "@ebike-backend/search";
import { SerializeGroup } from "@ebike-backend/utils";

@Controller("admin-thread-search-task")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminThreadSearchTaskController {
  constructor(private readonly searchService: ThreadSearchTaskSearchService) {}

  @Post("search")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchThreadSearchTasks(
    @Body() searchParams: ThreadSearchTaskSearchParams,
  ): Promise<ThreadSearchTaskSearchResult> {
    return this.searchService.search(searchParams);
  }
}
