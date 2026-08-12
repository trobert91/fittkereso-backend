import {
  Body,
  Controller,
  Post,
  SerializeOptions,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, RoleGuard, Roles } from '@fittkereso-backend/auth';
import { UserRole } from '@fittkereso-backend/database';
import {
  TaskSearchParams,
  TaskSearchResult,
  TaskSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';

@Controller('admin-task')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminTaskController {
  constructor(private readonly searchService: TaskSearchService) {}

  @Post('search')
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
