import {
  Body,
  Controller,
  Post,
  SerializeOptions,
} from '@nestjs/common';
import { MinRole } from '@fittkereso-backend/auth';
import { ScrapeTask, UserRole } from '@fittkereso-backend/database';
import {
  ScrapeTaskSearchParams,
  ScrapeTaskSearchResult,
  ScrapeTaskSearchService,
} from '@fittkereso-backend/search';
import {
  ScrapeTaskCreateDto,
  ScrapeTaskCreatorService,
} from '@fittkereso-backend/task';
import { SerializeGroup } from '@fittkereso-backend/utils';

@Controller('admin-scrape-task')
@MinRole(UserRole.admin)
export class AdminScrapeTaskController {
  constructor(
    private readonly searchService: ScrapeTaskSearchService,
    private readonly scrapeTaskCreatorService: ScrapeTaskCreatorService,
  ) {}

  @Post('search')
  @MinRole(UserRole.user)
  @SerializeOptions({
    strategy: 'exposeAll',
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

  @Post('create')
  @SerializeOptions({
    strategy: 'exposeAll',
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
