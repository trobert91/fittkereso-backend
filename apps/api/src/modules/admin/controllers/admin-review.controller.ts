import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  Review,
  ReviewRepository,
  UserComment,
  UserRole,
} from "@ebike-backend/database";
import { ProductImageDtoService } from "@ebike-backend/product";
import {
  ReviewSearchParams,
  ReviewSearchResult,
  ReviewSearchService,
} from "@ebike-backend/search";
import { nameOf, SerializeGroup } from "@ebike-backend/utils";
import { compact } from "lodash";

class UpdateReviewDto {
  enabled?: boolean;
}

@Controller("admin-review")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminReviewController {
  constructor(
    private readonly searchService: ReviewSearchService,
    private readonly imageDtoService: ProductImageDtoService,
    private readonly reviewRepo: ReviewRepository,
  ) {}

  @Post("search")
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async searchReviews(
    @Body() searchParams: ReviewSearchParams,
  ): Promise<ReviewSearchResult> {
    const result = await this.searchService.search(searchParams);

    this.imageDtoService.updateProductImageUrls(
      compact((result.items ?? []).map((review) => review.model)),
    );

    return result;
  }

  @Get(":id")
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async getReview(@Param("id") reviewId: string): Promise<Review> {
    const review = await this.reviewRepo.findOneOrFail({
      where: { id: reviewId },
      relations: [
        nameOf<Review>("model"),
        `${nameOf<Review>("model")}.${nameOf<ProductModel>("brand")}`,
        `${nameOf<Review>("model")}.${nameOf<ProductModel>("productCategory")}`,
        `${nameOf<Review>("model")}.${nameOf<ProductModel>("mainImage")}`,
        nameOf<Review>("candidates"),
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("thread")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("parent")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("parent")}.${nameOf<UserComment>("parent")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("parent")}.${nameOf<UserComment>("parent")}.${nameOf<UserComment>("parent")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("candidates")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}`,
        `${nameOf<Review>("candidates")}.${nameOf<ProductReferenceCandidate>("reference")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}.${nameOf<ProductModel>("mainImage")}`,
      ],
    });

    this.imageDtoService.updateProductImageUrls(compact([review.model]));

    this.imageDtoService.updateProductImageUrls(
      compact(
        (review.candidates ?? [])
          .flatMap((candidate) => candidate.reference?.candidates ?? [])
          .map((candidate) => candidate.model),
      ),
    );

    return review;
  }

  @Put(":id")
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async updateReview(
    @Param("id") id: string,
    @Body() updateDto: UpdateReviewDto,
  ): Promise<{ success: boolean }> {
    const updateFields: Record<string, unknown> = {};

    if (updateDto.enabled !== undefined) {
      updateFields.enabled = updateDto.enabled;
    }

    await this.reviewRepo.repo.update(id, updateFields);

    return { success: true };
  }
}
