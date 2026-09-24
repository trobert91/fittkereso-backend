import {
  Body,
  Controller,
  Post,
  SerializeOptions,
} from '@nestjs/common';
import { MinRole } from '@fittkereso-backend/auth';
import { ProductImportTask, UserRole } from '@fittkereso-backend/database';
import {
  ProductImportTaskSearchParams,
  ProductImportTaskSearchResult,
  ProductImportTaskSearchService,
} from '@fittkereso-backend/search';
import {
  ProductImportTaskCreateDto,
  ProductImportTaskCreatorService,
} from '@fittkereso-backend/task';
import { SerializeGroup } from '@fittkereso-backend/utils';

@Controller('admin-product-import-task')
@MinRole(UserRole.admin)
export class AdminProductImportTaskController {
  constructor(
    private readonly searchService: ProductImportTaskSearchService,
    private readonly importTaskCreatorService: ProductImportTaskCreatorService,
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
  async searchImportTasks(
    @Body() searchParams: ProductImportTaskSearchParams,
  ): Promise<ProductImportTaskSearchResult> {
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
  async createImportTask(
    @Body() createDto: ProductImportTaskCreateDto,
  ): Promise<ProductImportTask> {
    return this.importTaskCreatorService.create(createDto);
  }
}
