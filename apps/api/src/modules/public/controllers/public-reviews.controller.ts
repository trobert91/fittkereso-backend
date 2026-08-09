import { Controller, Get, Param, SerializeOptions } from "@nestjs/common";
import { SerializeGroup } from "@ebike-backend/utils";
import { PublicReviewsService } from "../services/public-reviews.service";
import { ReviewDetailDto } from "../dto/review.dto";

@Controller("v1/public/reviews")
@SerializeOptions({ groups: [SerializeGroup.list, SerializeGroup.details] })
export class PublicReviewsController {
  constructor(private readonly reviewsService: PublicReviewsService) {}

  @Get(":reviewId")
  async getReviewDetail(
    @Param("reviewId") reviewId: string,
  ): Promise<ReviewDetailDto> {
    return this.reviewsService.getReviewDetail(reviewId);
  }
}
