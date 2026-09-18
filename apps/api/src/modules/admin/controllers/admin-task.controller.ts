import {
  Body,
  Controller,
  Post,
  SerializeOptions,
} from '@nestjs/common';
import { MinRole } from '@fittkereso-backend/auth';
import { UserRole } from '@fittkereso-backend/database';
import {
  TaskSearchParams,
  TaskSearchResult,
  TaskSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';

@Controller('admin-task')
@MinRole(UserRole.admin)
export class AdminTaskController {
  constructor(private readonly searchService: TaskSearchService) {}

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
  async searchTasks(
    @Body() searchParams: TaskSearchParams,
  ): Promise<TaskSearchResult> {
    return await this.searchService.search(searchParams);
  }
}
