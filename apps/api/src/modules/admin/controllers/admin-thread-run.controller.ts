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
  ThreadRunSearchParams,
  ThreadRunSearchResult,
  ThreadRunSearchService,
} from "@ebike-backend/search";
import { SerializeGroup } from "@ebike-backend/utils";

@Controller("admin-thread-run")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminThreadRunController {
  constructor(private readonly searchService: ThreadRunSearchService) {}

  @Post("search")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchThreadRuns(
    @Body() searchParams: ThreadRunSearchParams,
  ): Promise<ThreadRunSearchResult> {
    return await this.searchService.search(searchParams);
  }
}
