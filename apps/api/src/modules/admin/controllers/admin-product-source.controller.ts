import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  SerializeOptions,
} from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, MinRole } from '@fittkereso-backend/auth';
import {
  isProductSourceType,
  PRODUCT_SOURCE_TYPES,
  ProductSource,
  ProductSourceConfigValidatorService,
  ProductSourceRecordRepository,
  ProductSourceRepository,
  ProductSourceVersion,
  UserRole,
} from '@fittkereso-backend/database';
import {
  ProductSourceUpdateService,
  ProductSourceVersionService,
} from '@fittkereso-backend/product';
import {
  ProductSourceSearchParams,
  ProductSourceSearchResult,
  ProductSourceSearchService,
} from '@fittkereso-backend/search';
import { QueuePublisherService } from '@fittkereso-backend/task';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { UpdateProductSourceDto } from '../dtos/update-product-source.dto';
import {
  QueueStatusDto,
  TriggerProductSourceFullSyncDto,
} from '../dtos/product-source-sync.dto';
import {
  actorFor,
  ProductSourceActionListDto,
  ProductSourceHistoryQueryDto,
  ProductSourceVersionListDto,
} from '../dtos/product-source-history.dto';
import {
  ProductSourceRecordListDto,
  ProductSourceRecordQueryDto,
} from '../dtos/product-source-record.dto';

@Controller('admin-product-source')
@MinRole(UserRole.admin)
export class AdminProductSourceController {
  constructor(
    private readonly searchService: ProductSourceSearchService,
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly queuePublisher: QueuePublisherService,
    private readonly updateService: ProductSourceUpdateService,
    private readonly configValidator: ProductSourceConfigValidatorService,
    private readonly versionService: ProductSourceVersionService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
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
  async searchProductSources(
    @Body() searchParams: ProductSourceSearchParams,
  ): Promise<ProductSourceSearchResult> {
    return await this.searchService.search(searchParams);
  }

  /**
   * The JSON Schema every product source config is validated against.
   *
   * Declared BEFORE `GET :id`, and it has to stay there: Nest matches routes
   * in declaration order, so below it "config-schema" would be swallowed as
   * an :id and answered with a 404.
   *
   * `exposeAll` because the schema is a plain object rather than an entity —
   * the global serializer runs excludeAll, and without this the response is
   * an empty object.
   *
   * Served rather than duplicated in the admin client: the editor validates
   * against the same document the backend rejects saves with, so the two
   * cannot disagree about what a valid config is.
   */
  @Get('config-schema')
  @MinRole(UserRole.user)
  @SerializeOptions({ strategy: 'exposeAll' })
  getConfigSchema(
    @Query('type') type?: string,
  ): Record<string, unknown> {
    // A source's config shape is decided by its type, so the editor must ask
    // for the right one. Without a type, every schema is returned keyed by
    // type — the editor can then pick, and nothing has to guess a default that
    // would silently validate the wrong shape.
    if (!type) {
      return this.configValidator.allSchemas as unknown as Record<string, unknown>;
    }

    if (!isProductSourceType(type)) {
      throw new BadRequestException(
        `Unknown product source type "${type}" — expected one of ` +
          `${PRODUCT_SOURCE_TYPES.join(', ')}.`,
      );
    }

    return this.configValidator.schemaFor(type) as Record<string, unknown>;
  }

  @Get(':id')
  @MinRole(UserRole.user)
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  /**
   * The source, with its config history and audit trail attached.
   *
   * One response carries everything the details page renders, so the page has
   * no second request to make and cannot show a source and a history that
   * disagree. The update and restore routes answer with the same shape.
   */
  async getProductSource(
    @Param('id') productSourceId: string,
  ): Promise<ProductSource> {
    return this.versionService.getDetail(productSourceId);
  }

  @Put(':id')
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateProductSource(
    @Param('id') productSourceId: string,
    @Body() updateDto: UpdateProductSourceDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<ProductSource> {
    return this.updateService.updateProductSource(productSourceId, {
      ...updateDto,
      actor: actorFor(currentUser),
    });
  }

  /**
   * Every configuration this source has had, newest number first.
   *
   * Paged rather than returned whole: a source edited often accumulates
   * versions indefinitely, and each row carries a complete config.
   */
  @Get(':id/versions')
  @MinRole(UserRole.user)
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async listVersions(
    @Param('id') productSourceId: string,
    @Query() query: ProductSourceHistoryQueryDto,
  ): Promise<ProductSourceVersionListDto> {
    const [items, total] = await this.versionService.listVersions(productSourceId, {
      skip: query.skip,
      take: query.take,
    });

    return { items, total };
  }

  /** One numbered revision, with its whole config. */
  @Get(':id/versions/:version')
  @MinRole(UserRole.user)
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async getVersion(
    @Param('id') productSourceId: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<ProductSourceVersion> {
    return this.versionService.getVersion(productSourceId, version);
  }

  /**
   * Puts an earlier config back, as a NEW version.
   *
   * Addressed by the version being restored FROM. Restoring v2 while v5 is in
   * force writes v6 carrying v2's config: v2 stays where it is, v5 stays in
   * the history, and the restore is itself reversible.
   */
  @Post(':id/versions/:version/restore')
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async restoreVersion(
    @Param('id') productSourceId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<ProductSource> {
    return this.versionService.restoreVersion(
      productSourceId,
      version,
      actorFor(currentUser),
    );
  }

  /** The audit timeline: what happened to this source, when, and who did it. */
  @Get(':id/actions')
  @MinRole(UserRole.user)
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async listActions(
    @Param('id') productSourceId: string,
    @Query() query: ProductSourceHistoryQueryDto,
  ): Promise<ProductSourceActionListDto> {
    const [items, total] = await this.versionService.listActions(productSourceId, {
      skip: query.skip,
      take: query.take,
    });

    return { items, total };
  }

  /**
   * The source's listings, newest sighting first.  lists
   * the ones waiting unattached: rows of a source that does not identify
   * products, whose offer its seller's identifying source has not written.
   */
  @Get(':id/records')
  @MinRole(UserRole.user)
  @SerializeOptions({ strategy: 'exposeAll', groups: [SerializeGroup.list] })
  async listRecords(
    @Param('id') productSourceId: string,
    @Query() query: ProductSourceRecordQueryDto,
  ): Promise<ProductSourceRecordListDto> {
    return this.sourceRecordRepo.searchRecords({
      productSourceId,
      attached: query.attached,
      search: query.search,
      skip: query.skip,
      take: query.take,
    });
  }

  @Post(':id/full-sync')
  async triggerFullSync(
    @Param('id') productSourceId: string,
    @Body() body: TriggerProductSourceFullSyncDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<QueueStatusDto> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    await this.queuePublisher.addProductSourceSyncTask({
      productSourceId,
      categoryIds: body?.categoryIds,
      brandNames: body?.brandNames,
    });

    // Recorded as 'manual' because this route only exists for a person
    // pressing a button; the scheduler queues its own syncs without coming
    // through here at all.
    await this.versionService.recordAction(
      source,
      'sync_triggered',
      {
        mode: 'full',
        trigger: 'manual',
        categoryIds: body?.categoryIds ?? null,
        brandNames: body?.brandNames ?? null,
      },
      actorFor(currentUser),
    );

    return { status: 'queued' };
  }
}
