import {
  BadRequestException,
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
  ProductResolutionDecision,
  ProductResolutionFlow,
  ProductResolutionRepository,
  ProductModel,
  UserRole,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import {
  ProductDuplicateEvaluationService,
  ProductImageDtoService,
  ProductMergeService,
} from '@fittkereso-backend/product';
import {
  ProductResolutionSearchParams,
  ProductResolutionSearchResult,
  ProductResolutionSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { IsOptional, IsString } from 'class-validator';
import type { DuplicateDetectionRunSummary } from '@fittkereso-backend/product';
import { compact } from 'lodash';

class RejectResolutionDto {
  @IsOptional()
  @IsString()
  note?: string;
}

class TriggerDuplicateDetectionDto {
  @IsOptional()
  @IsString()
  categoryId?: string;
}

/** Both flow types are actionable via approve/reject, but the side effects
 *  differ: `duplicate_detection` approve triggers a real merge (unchanged
 *  from before this controller covered both flows); `product_resolution`
 *  approve/reject are confirmation-only (decision/reviewedAt/reviewNote), with
 *  no catalog mutation — a record of a human's judgment on the resolution
 *  engine's decision, for tuning thresholds later. */
@Controller('admin-product/resolutions')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminResolutionController {
  constructor(
    private readonly resolutionSearchService: ProductResolutionSearchService,
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly mergeService: ProductMergeService,
    private readonly evaluationService: ProductDuplicateEvaluationService,
    private readonly imageDtoService: ProductImageDtoService,
  ) {}

  @Post('search')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async searchResolutions(
    @Body() params: ProductResolutionSearchParams,
  ): Promise<ProductResolutionSearchResult> {
    return this.resolutionSearchService.search(params);
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
  async getResolution(@Param('id') id: string): Promise<ProductResolution> {
    const productRelations = [
      nameOf<ProductModel>('brand'),
      nameOf<ProductModel>('productCategory'),
      nameOf<ProductModel>('sources'),
      nameOf<ProductModel>('images'),
      nameOf<ProductModel>('mainImage'),
      nameOf<ProductModel>('aliases'),
    ];
    const relationsFor = (field: keyof ProductResolution) => [
      nameOf<ProductResolution>(field),
      ...productRelations.map(
        (relation) => `${nameOf<ProductResolution>(field)}.${relation}`,
      ),
    ];

    const resolution = await this.resolutionRepo.findOne({
      where: { id },
      relations: [
        ...relationsFor('productA'),
        ...relationsFor('productB'),
        ...relationsFor('resolvedProduct'),
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
      ]),
    );

    return resolution;
  }

  @Post(':id/approve')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async approveResolution(@Param('id') id: string): Promise<ProductResolution> {
    const resolution = await this.resolutionRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductResolution>('productA'),
        `${nameOf<ProductResolution>('productA')}.${nameOf<ProductModel>('brand')}`,
        `${nameOf<ProductResolution>('productA')}.${nameOf<ProductModel>('productCategory')}`,
        nameOf<ProductResolution>('productB'),
        `${nameOf<ProductResolution>('productB')}.${nameOf<ProductModel>('brand')}`,
        `${nameOf<ProductResolution>('productB')}.${nameOf<ProductModel>('productCategory')}`,
      ],
    });

    if (!resolution) {
      throw new NotFoundException(`Resolution ${id} not found`);
    }

    if (resolution.decision !== ProductResolutionDecision.pending_review) {
      throw new BadRequestException(
        `Cannot approve resolution with decision "${resolution.decision}"`,
      );
    }

    if (resolution.flow === ProductResolutionFlow.duplicate_detection) {
      // productA/productB are guaranteed non-null for this flow.
      const { sourceId, targetId } = this.evaluationService.selectMergeTarget(
        {
          id: resolution.productA!.id,
          createdAt: resolution.productA!.createdAt,
        },
        {
          id: resolution.productB!.id,
          createdAt: resolution.productB!.createdAt,
        },
      );

      await this.mergeService.mergeProducts({ sourceId, targetId });
      resolution.mergedAt = new Date();
    }
    // product_resolution: confirmation-only, no catalog mutation.

    resolution.decision = ProductResolutionDecision.approved;
    resolution.reviewedAt = new Date();
    return this.resolutionRepo.save(resolution);
  }

  @Delete(':id')
  async deleteResolution(@Param('id') id: string): Promise<void> {
    const exists = await this.resolutionRepo.findOne({ where: { id } });

    if (!exists) {
      throw new NotFoundException(`Resolution ${id} not found`);
    }

    await this.resolutionRepo.deleteById(id);
  }

  @Post(':id/reject')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async rejectResolution(
    @Param('id') id: string,
    @Body() body: RejectResolutionDto,
  ): Promise<ProductResolution> {
    const resolution = await this.resolutionRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductResolution>('productA'),
        nameOf<ProductResolution>('productB'),
      ],
    });

    if (!resolution) {
      throw new NotFoundException(`Resolution ${id} not found`);
    }

    // Reject is allowed from pending_review OR auto_accepted (unlike approve,
    // which only makes sense from pending_review) — a human can override a
    // confident auto-decision after the fact. approved/rejected stay terminal.
    const rejectableFrom: ProductResolutionDecision[] = [
      ProductResolutionDecision.pending_review,
      ProductResolutionDecision.auto_accepted,
    ];
    if (!rejectableFrom.includes(resolution.decision)) {
      throw new BadRequestException(
        `Cannot reject resolution with decision "${resolution.decision}"`,
      );
    }

    resolution.decision = ProductResolutionDecision.rejected;
    resolution.reviewedAt = new Date();
    resolution.reviewNote = body.note ?? null;
    return this.resolutionRepo.save(resolution);
  }
}
