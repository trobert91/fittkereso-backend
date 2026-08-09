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
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  ProductDuplicate,
  ProductDuplicateDecision,
  ProductDuplicateRepository,
  ProductModel,
  ProductReferenceCandidateRepository,
  UserRole,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import {
  ProductDuplicateEvaluationService,
  ProductImageDtoService,
  ProductMergeService,
} from "@ebike-backend/product";
import {
  ProductDuplicateSearchParams,
  ProductDuplicateSearchResult,
  ProductDuplicateSearchService,
} from "@ebike-backend/search";
import { SerializeGroup } from "@ebike-backend/utils";
import { IsOptional, IsString } from "class-validator";
import type { DuplicateDetectionRunSummary } from "@ebike-backend/product";

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

@Controller("admin-product/duplicate-pairs")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminDuplicateController {
  constructor(
    private readonly duplicateSearchService: ProductDuplicateSearchService,
    private readonly duplicateRepo: ProductDuplicateRepository,
    private readonly candidateRepo: ProductReferenceCandidateRepository,
    private readonly mergeService: ProductMergeService,
    private readonly evaluationService: ProductDuplicateEvaluationService,
    private readonly imageDtoService: ProductImageDtoService,
  ) {}

  @Post("search")
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async searchDuplicatePairs(
    @Body() params: ProductDuplicateSearchParams,
  ): Promise<ProductDuplicateSearchResult> {
    return this.duplicateSearchService.search(params);
  }

  @Post("trigger")
  @SerializeOptions({ strategy: "exposeAll" })
  async triggerDuplicateDetection(
    @Body() body: TriggerDuplicateDetectionDto,
  ): Promise<DuplicateDetectionRunSummary> {
    return this.evaluationService.processAllCategories(body.categoryId);
  }

  @Get(":id")
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async getDuplicatePair(@Param("id") id: string): Promise<ProductDuplicate> {
    const duplicate = await this.duplicateRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductDuplicate>("productA"),
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("brand")}`,
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("productCategory")}`,
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("sources")}`,
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("images")}`,
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("mainImage")}`,
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("aliases")}`,
        nameOf<ProductDuplicate>("productB"),
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("brand")}`,
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("productCategory")}`,
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("sources")}`,
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("images")}`,
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("mainImage")}`,
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("aliases")}`,
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

  @Post(":id/approve")
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async approvePair(@Param("id") id: string): Promise<ProductDuplicate> {
    const duplicate = await this.duplicateRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductDuplicate>("productA"),
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("brand")}`,
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("productCategory")}`,
        `${nameOf<ProductDuplicate>("productA")}.${nameOf<ProductModel>("reviews")}`,
        nameOf<ProductDuplicate>("productB"),
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("brand")}`,
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("productCategory")}`,
        `${nameOf<ProductDuplicate>("productB")}.${nameOf<ProductModel>("reviews")}`,
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

    // Count distinct references that have a candidate pointing at each
    // product — i.e. the number of source references each product attracts,
    // regardless of which candidate slot (primary vs. runner-up) they fill.
    const countReferencesByModel = (modelId: string): Promise<number> =>
      this.candidateRepo.repo
        .createQueryBuilder("candidate")
        .where("candidate.modelId = :modelId", { modelId })
        .select("COUNT(DISTINCT candidate.referenceId)", "count")
        .getRawOne<{ count: string }>()
        .then((row) => Number(row?.count ?? 0));

    const [refCountA, refCountB] = await Promise.all([
      countReferencesByModel(duplicate.productA.id),
      countReferencesByModel(duplicate.productB.id),
    ]);

    const reviewCountA = duplicate.productA.reviews?.length ?? 0;
    const reviewCountB = duplicate.productB.reviews?.length ?? 0;

    const { sourceId, targetId } = this.evaluationService.selectMergeTarget(
      {
        id: duplicate.productA.id,
        reviewCount: reviewCountA,
        createdAt: duplicate.productA.createdAt,
      },
      {
        id: duplicate.productB.id,
        reviewCount: reviewCountB,
        createdAt: duplicate.productB.createdAt,
      },
      refCountA,
      refCountB,
    );

    await this.mergeService.mergeProducts({ sourceId, targetId });

    duplicate.decision = ProductDuplicateDecision.approved;
    duplicate.mergedAt = new Date();
    duplicate.reviewedAt = new Date();
    return this.duplicateRepo.save(duplicate);
  }

  @Delete(":id")
  async deletePair(@Param("id") id: string): Promise<void> {
    const exists = await this.duplicateRepo.findOne({ where: { id } });

    if (!exists) {
      throw new NotFoundException(`Duplicate pair ${id} not found`);
    }

    await this.duplicateRepo.deleteById(id);
  }

  @Post(":id/reject")
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async rejectPair(
    @Param("id") id: string,
    @Body() body: RejectDuplicateDto,
  ): Promise<ProductDuplicate> {
    const duplicate = await this.duplicateRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductDuplicate>("productA"),
        nameOf<ProductDuplicate>("productB"),
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
