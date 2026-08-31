import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  SerializeOptions,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, RoleGuard, Roles } from '@fittkereso-backend/auth';
import {
  ProductResolution,
  ProductResolutionRepository,
  ProductModel,
  ProductSourceRecord,
  ResolutionCorrection,
  UserRole,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import {
  ProductDuplicateEvaluationService,
  ProductImageDtoService,
  ProductResolutionActionService,
  ProductResolutionStateService,
} from '@fittkereso-backend/product';
import {
  ProductResolutionSearchParams,
  ProductResolutionSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import type { DuplicateDetectionRunSummary } from '@fittkereso-backend/product';
import { compact } from 'lodash';
import {
  ResolutionListItem,
  ResolutionListResult,
} from '../dtos/resolution-list.dto';

class ReviewNoteDto {
  @IsOptional()
  @IsString()
  note?: string;
}

class DeclineResolutionDto extends ReviewNoteDto {
  @IsEnum(ResolutionCorrection)
  correction: ResolutionCorrection;

  /** Required when `correction` is `merge_into`. */
  @IsOptional()
  @IsString()
  targetProductId?: string;
}

class TriggerDuplicateDetectionDto {
  @IsOptional()
  @IsString()
  categoryId?: string;
}

/**
 * The product-resolution review queue.
 *
 * Read endpoints return each row together with its derived `state` — which
 * actions are legal right now and why. Write endpoints delegate every decision
 * to `ProductResolutionActionService`, which re-derives that same state from
 * live data before acting, so this controller holds no workflow logic of its
 * own.
 */
@Controller('admin-product/resolutions')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminResolutionController {
  constructor(
    private readonly resolutionSearchService: ProductResolutionSearchService,
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly actionService: ProductResolutionActionService,
    private readonly stateService: ProductResolutionStateService,
    private readonly evaluationService: ProductDuplicateEvaluationService,
    private readonly imageDtoService: ProductImageDtoService,
  ) {}

  @Post('search')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async searchResolutions(
    @Body() params: ProductResolutionSearchParams,
  ): Promise<ResolutionListResult> {
    const result = await this.resolutionSearchService.search(params);
    const items = result.items ?? [];

    this.imageDtoService.updateProductImageUrls(
      this.resolutionSearchService.collectProducts(items),
    );

    const page = new ResolutionListResult();
    // The pure derivation here — one page of rows must not cost a query per
    // row. The orchestrator re-derives against live data before acting.
    page.items = items.map((resolution) =>
      ResolutionListItem.of(resolution, this.stateService.derive(resolution)),
    );
    page.page = result.page;
    page.pageSize = result.pageSize;
    page.totalItems = result.totalItems;
    page.totalPages = result.totalPages;

    return page;
  }

  @Post('trigger')
  @SerializeOptions({ strategy: 'exposeAll' })
  async triggerDuplicateDetection(
    @Body() body: TriggerDuplicateDetectionDto,
  ): Promise<DuplicateDetectionRunSummary> {
    return this.evaluationService.processAllCategories(body.categoryId);
  }

  @Get(':id')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async getResolution(@Param('id') id: string): Promise<ResolutionListItem> {
    return this.loadItem(id);
  }

  /** "The system got this right." Executes the proposed merge if one is still
   *  pending; otherwise records the confirmation. */
  @Post(':id/accept')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async acceptResolution(
    @Param('id') id: string,
    @Body() body: ReviewNoteDto,
  ): Promise<ResolutionListItem> {
    return this.loadItemAfter(this.actionService.accept(id, body));
  }

  /** "The current state is wrong." The legal corrections depend on the last
   *  performed action — see the row's `state.availableActions`. */
  @Post(':id/decline')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async declineResolution(
    @Param('id') id: string,
    @Body() body: DeclineResolutionDto,
  ): Promise<ResolutionListItem> {
    return this.loadItemAfter(this.actionService.decline(id, body));
  }

  /** Puts a decided row back in the queue. Catalog effects are not undone —
   *  the reopened row offers the correction that reverses them. */
  @Post(':id/reopen')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async reopenResolution(
    @Param('id') id: string,
    @Body() body: ReviewNoteDto,
  ): Promise<ResolutionListItem> {
    return this.loadItemAfter(this.actionService.reopen(id, body));
  }

  /** Re-runs an action that failed, against freshly derived state. */
  @Post(':id/retry')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async retryResolution(
    @Param('id') id: string,
  ): Promise<ResolutionListItem> {
    return this.loadItemAfter(this.actionService.retry(id));
  }

  @Delete(':id')
  async deleteResolution(@Param('id') id: string): Promise<void> {
    const exists = await this.resolutionRepo.findOne({ where: { id } });

    if (!exists) {
      throw new NotFoundException(`Resolution ${id} not found`);
    }

    await this.resolutionRepo.deleteById(id);
  }

  /** Runs an action, then returns the row as the detail endpoint would. The
   *  client needs the re-derived state to know what is legal next, so handing
   *  back only the entity would force it into a second round-trip. */
  private async loadItemAfter(
    action: Promise<ProductResolution>,
  ): Promise<ResolutionListItem> {
    const { id } = await action;
    return this.loadItem(id);
  }

  /** One row with every relation the review UI renders, its image URLs
   *  resolved, and its state derived against live data. */
  private async loadItem(id: string): Promise<ResolutionListItem> {
    const fullProduct = [
      nameOf<ProductModel>('brand'),
      nameOf<ProductModel>('productCategory'),
      nameOf<ProductModel>('sources'),
      nameOf<ProductModel>('images'),
      nameOf<ProductModel>('mainImage'),
      nameOf<ProductModel>('aliases'),
    ];
    // `ProductSourceRecord.model` and `ProductModel.sources` reference each
    // other, so the listing's own product is loaded without `sources` — enough
    // to render it, and it keeps the cycle unpopulated.
    const listingProduct = [
      nameOf<ProductModel>('brand'),
      nameOf<ProductModel>('productCategory'),
      nameOf<ProductModel>('mainImage'),
    ];
    /** A product relation plus everything the UI renders about that product. */
    const productAt = (path: string, relations = fullProduct) => [
      path,
      ...relations.map((relation) => `${path}.${relation}`),
    ];

    const sourceRecord = nameOf<ProductResolution>('sourceRecord');

    const resolution = await this.resolutionRepo.findOne({
      where: { id },
      relations: [
        ...productAt(nameOf<ProductResolution>('productA')),
        ...productAt(nameOf<ProductResolution>('productB')),
        ...productAt(nameOf<ProductResolution>('resolvedProduct')),
        // The reviewed listing, its source, and — via `model` — the product it
        // currently sits on, which is not necessarily `resolvedProduct`.
        sourceRecord,
        `${sourceRecord}.${nameOf<ProductSourceRecord>('source')}`,
        ...productAt(
          `${sourceRecord}.${nameOf<ProductSourceRecord>('model')}`,
          listingProduct,
        ),
      ],
    });

    if (!resolution) {
      throw new NotFoundException(`Resolution ${id} not found`);
    }

    this.imageDtoService.updateProductImageUrls(
      compact([
        resolution.productA,
        resolution.productB,
        resolution.resolvedProduct,
        resolution.sourceRecord?.model,
      ]),
    );

    // The verified derivation: a detail view is worth the extra reads, and it
    // is what tells the reviewer when an action they expect is unavailable.
    return ResolutionListItem.of(
      resolution,
      await this.stateService.deriveVerified(resolution),
    );
  }
}
