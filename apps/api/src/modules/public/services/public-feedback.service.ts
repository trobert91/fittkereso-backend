import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  Review,
  ReviewRepository,
  ReviewFeedback,
  ReviewFeedbackCategory,
} from "@ebike-backend/database";
import { ReviewFeedbackEmailService } from "@ebike-backend/email";
import { nameOf } from "@ebike-backend/utils";
import { RecaptchaService } from "./recaptcha.service";

@Injectable()
export class PublicFeedbackService {
  constructor(
    private readonly recaptchaService: RecaptchaService,
    private readonly reviewRepo: ReviewRepository,
    private readonly feedbackEmailService: ReviewFeedbackEmailService,
    @InjectDataSource("postgres")
    private readonly dataSource: DataSource,
  ) {}

  async submitFeedback(params: {
    reviewId: string;
    category: ReviewFeedbackCategory;
    description?: string;
    recaptchaToken: string;
    ipAddress?: string;
  }): Promise<void> {
    const verified = await this.recaptchaService.verifyToken(
      params.recaptchaToken,
    );
    if (!verified) {
      throw new BadRequestException("reCAPTCHA verification failed");
    }

    const review = await this.reviewRepo.repo
      .createQueryBuilder("review")
      .leftJoinAndSelect(`review.${nameOf<Review>("model")}`, "model")
      .where(`review.${nameOf<Review>("id")} = :id`, { id: params.reviewId })
      .getOne();

    if (!review) {
      throw new NotFoundException(
        `Review with id "${params.reviewId}" not found`,
      );
    }

    const feedbackRepo = this.dataSource.getRepository(ReviewFeedback);
    const feedback = feedbackRepo.create({
      review,
      category: params.category,
      description: params.description ?? null,
      ipAddress: params.ipAddress ?? null,
    });
    await feedbackRepo.save(feedback);

    // Fire-and-forget email notification
    this.feedbackEmailService
      .sendFeedbackNotification({
        productSlug: review.model?.slug ?? "",
        reviewId: params.reviewId,
        category: params.category,
        description: params.description,
      })
      .catch(() => {
        // Swallow email errors — feedback was saved successfully
      });
  }
}
