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
  TaskSearchParams,
  TaskSearchResult,
  TaskSearchService,
} from "@ebike-backend/search";
import { SerializeGroup } from "@ebike-backend/utils";

@Controller("admin-task")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminTaskController {
  constructor(private readonly searchService: TaskSearchService) {}

  @Post("search")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchTasks(
    @Body() searchParams: TaskSearchParams,
  ): Promise<TaskSearchResult> {
    return await this.searchService.search(searchParams);
  }
}
