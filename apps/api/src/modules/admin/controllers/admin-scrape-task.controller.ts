import {
  Body,
  Controller,
  Post,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import { ScrapeTask, UserRole } from "@ebike-backend/database";
import {
  ScrapeTaskSearchParams,
  ScrapeTaskSearchResult,
  ScrapeTaskSearchService,
} from "@ebike-backend/search";
import {
  ScrapeTaskCreateDto,
  ScrapeTaskCreatorService,
} from "@ebike-backend/task";
import { SerializeGroup } from "@ebike-backend/utils";

@Controller("admin-scrape-task")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminScrapeTaskController {
  constructor(
    private readonly searchService: ScrapeTaskSearchService,
    private readonly scrapeTaskCreatorService: ScrapeTaskCreatorService,
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
  async searchScrapeTasks(
    @Body() searchParams: ScrapeTaskSearchParams,
  ): Promise<ScrapeTaskSearchResult> {
    return this.searchService.search(searchParams);
  }

  @Post("create")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async createScrapeTask(
    @Body() createDto: ScrapeTaskCreateDto,
  ): Promise<ScrapeTask> {
    return this.scrapeTaskCreatorService.create(createDto);
  }
}
