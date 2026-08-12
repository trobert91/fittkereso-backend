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
  ProductDuplicate,
  ProductDuplicateDecision,
  ProductDuplicateRepository,
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
  ProductDuplicateSearchParams,
  ProductDuplicateSearchResult,
  ProductDuplicateSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { IsOptional, IsString } from 'class-validator';
import type { DuplicateDetectionRunSummary } from '@fittkereso-backend/product';

class RejectDuplicateDto {
  @IsOptional()
  @IsString()
  note?: string;
}

class TriggerDuplicateDetectionDto {
  @IsOptional()
  @IsString()
  categoryId?: string;
}

@Controller('admin-product/duplicate-pairs')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminDuplicateController {
  constructor(
    private readonly duplicateSearchService: ProductDuplicateSearchService,
    private readonly duplicateRepo: ProductDuplicateRepository,
    private readonly mergeService: ProductMergeService,
    private readonly evaluationService: ProductDuplicateEvaluationService,
    private readonly imageDtoService: ProductImageDtoService,
  ) {}

  @Post('search')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async searchDuplicatePairs(
    @Body() params: ProductDuplicateSearchParams,
  ): Promise<ProductDuplicateSearchResult> {
    return this.duplicateSearchService.search(params);
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
  async getDuplicatePair(@Param('id') id: string): Promise<ProductDuplicate> {
    const duplicate = await this.duplicateRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductDuplicate>('productA'),
        `${nameOf<ProductDuplicate>('productA')}.${nameOf<ProductModel>('brand')}`,
        `${nameOf<ProductDuplicate>('productA')}.${nameOf<ProductModel>('productCategory')}`,
        `${nameOf<ProductDuplicate>('productA')}.${nameOf<ProductModel>('sources')}`,
        `${nameOf<ProductDuplicate>('productA')}.${nameOf<ProductModel>('images')}`,
        `${nameOf<ProductDuplicate>('productA')}.${nameOf<ProductModel>('mainImage')}`,
        `${nameOf<ProductDuplicate>('productA')}.${nameOf<ProductModel>('aliases')}`,
        nameOf<ProductDuplicate>('productB'),
        `${nameOf<ProductDuplicate>('productB')}.${nameOf<ProductModel>('brand')}`,
        `${nameOf<ProductDuplicate>('productB')}.${nameOf<ProductModel>('productCategory')}`,
        `${nameOf<ProductDuplicate>('productB')}.${nameOf<ProductModel>('sources')}`,
        `${nameOf<ProductDuplicate>('productB')}.${nameOf<ProductModel>('images')}`,
        `${nameOf<ProductDuplicate>('productB')}.${nameOf<ProductModel>('mainImage')}`,
        `${nameOf<ProductDuplicate>('productB')}.${nameOf<ProductModel>('aliases')}`,
      ],
    });

    if (!duplicate) {
      throw new NotFoundException(`Duplicate pair ${id} not found`);
    }

    this.imageDtoService.updateProductImageUrls([
      duplicate.productA,
      duplicate.productB,
    ]);

    return duplicate;
  }

  @Post(':id/approve')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async approvePair(@Param('id') id: string): Promise<ProductDuplicate> {
    const duplicate = await this.duplicateRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductDuplicate>('productA'),
        `${nameOf<ProductDuplicate>('productA')}.${nameOf<ProductModel>('brand')}`,
        `${nameOf<ProductDuplicate>('productA')}.${nameOf<ProductModel>('productCategory')}`,
        nameOf<ProductDuplicate>('productB'),
        `${nameOf<ProductDuplicate>('productB')}.${nameOf<ProductModel>('brand')}`,
        `${nameOf<ProductDuplicate>('productB')}.${nameOf<ProductModel>('productCategory')}`,
      ],
    });

    if (!duplicate) {
      throw new NotFoundException(`Duplicate pair ${id} not found`);
    }

    if (duplicate.decision !== ProductDuplicateDecision.pending_review) {
      throw new BadRequestException(
        `Cannot approve pair with decision "${duplicate.decision}"`,
      );
    }

    const { sourceId, targetId } = this.evaluationService.selectMergeTarget(
      { id: duplicate.productA.id, createdAt: duplicate.productA.createdAt },
      { id: duplicate.productB.id, createdAt: duplicate.productB.createdAt },
    );

    await this.mergeService.mergeProducts({ sourceId, targetId });

    duplicate.decision = ProductDuplicateDecision.approved;
    duplicate.mergedAt = new Date();
    duplicate.reviewedAt = new Date();
    return this.duplicateRepo.save(duplicate);
  }

  @Delete(':id')
  async deletePair(@Param('id') id: string): Promise<void> {
    const exists = await this.duplicateRepo.findOne({ where: { id } });

    if (!exists) {
      throw new NotFoundException(`Duplicate pair ${id} not found`);
    }

    await this.duplicateRepo.deleteById(id);
  }

  @Post(':id/reject')
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async rejectPair(
    @Param('id') id: string,
    @Body() body: RejectDuplicateDto,
  ): Promise<ProductDuplicate> {
    const duplicate = await this.duplicateRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductDuplicate>('productA'),
        nameOf<ProductDuplicate>('productB'),
      ],
    });

    if (!duplicate) {
      throw new NotFoundException(`Duplicate pair ${id} not found`);
    }

    if (duplicate.decision !== ProductDuplicateDecision.pending_review) {
      throw new BadRequestException(
        `Cannot reject pair with decision "${duplicate.decision}"`,
      );
    }

    duplicate.decision = ProductDuplicateDecision.rejected;
    duplicate.reviewedAt = new Date();
    duplicate.reviewNote = body.note ?? null;
    return this.duplicateRepo.save(duplicate);
  }
}
