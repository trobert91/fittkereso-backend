import { Injectable, NotFoundException } from "@nestjs/common";
import {
  collectAllFeatures,
  collectAllUseCases,
  Depth,
  ProductReference,
  ProductReferenceCandidate,
  Review,
  ReviewRepository,
  ThreadPlatform,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { compact } from "lodash";
import { RATING_DEFAULTS } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { nameOf, resolveExternalUrl } from "@ebike-backend/utils";
import {
  ReviewDetailDto,
  ReviewDetailReferenceDto,
  ReviewParentCommentDto,
} from "../dto/review.dto";
import { toReviewQuoteDto } from "./quote-dto.mapper";
import { IsNull } from "typeorm";

@Injectable()
export class PublicReviewsService {
  constructor(
    private readonly reviewRepo: ReviewRepository,
    private readonly userCommentRepo: UserCommentRepository,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  async getReviewDetail(reviewId: string): Promise<ReviewDetailDto> {
    const minReviewScore =
      this.dynamicConfigService.rating?.minReviewScore ??
      RATING_DEFAULTS.minReviewScore;

    const review = await this.reviewRepo.repo
      .createQueryBuilder("review")
      .leftJoinAndSelect(`review.${nameOf<Review>("candidates")}`, "candidates")
      .leftJoinAndSelect(
        `candidates.${nameOf<ProductReferenceCandidate>("reference")}`,
        "reference",
      )
      .leftJoinAndSelect(
        `reference.${nameOf<ProductReference>("comment")}`,
        "comment",
      )
      .leftJoinAndSelect(`comment.${nameOf<UserComment>("thread")}`, "thread")
      .where(`review.${nameOf<Review>("id")} = :reviewId`, { reviewId })
      .andWhere(`review.${nameOf<Review>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(
        `review."${nameOf<Review>("reviewScore")}" >= :minReviewScore`,
        { minReviewScore },
      )
      .andWhere(`review.${nameOf<Review>("deletedAt")} IS NULL`)
      .getOne();

    if (!review) {
      throw new NotFoundException(`Review not found`);
    }

    const dto = new ReviewDetailDto();
    dto.id = review.id;
    dto.sentiment = review.sentiment;
    dto.experience = review.experience;
    dto.depth = review.depth ?? Depth.Superficial;
    dto.intents = review.intents;
    dto.totalUpvotes = review.totalUpvotes ?? 0;
    dto.totalDownvotes = review.totalDownvotes ?? 0;
    dto.creationTs = review.externalCreationTs ?? new Date(0);
    dto.platform = review.platform ?? null;
    dto.quotes = (review.quotes ?? []).map((quote) => toReviewQuoteDto(quote));

    const linkedReferences = compact(
      (review.candidates ?? []).map((candidate) => candidate.reference),
    );
    dto.parts = await Promise.all(
      linkedReferences.map((reference) =>
        this.toDetailPartDto(reference, review.platform),
      ),
    );

    return dto;
  }

  private async toDetailPartDto(
    reference: ProductReference,
    platform: ThreadPlatform,
  ): Promise<ReviewDetailReferenceDto> {
    const comment = reference.comment;
    const partDto = new ReviewDetailReferenceDto();
    partDto.id = reference.id;
    partDto.commentBody = comment?.body ?? "";
    partDto.topic = comment?.thread?.topic ?? null;
    partDto.threadTitle = comment?.thread?.title ?? null;
    partDto.externalUrl = resolveExternalUrl(comment?.url, platform);
    partDto.sentiment = reference.sentiment ?? null;
    partDto.intents = reference.intents;
    partDto.experience = reference.experience ?? null;
    partDto.depth = reference.depth ?? null;
    partDto.upvotes = comment?.upvotes ?? 0;
    partDto.downvotes = comment?.downvotes ?? 0;
    const allFeatures = collectAllFeatures(reference);
    const allUseCases = collectAllUseCases(reference);
    partDto.features = allFeatures.length
      ? allFeatures.map((evidence) => ({
          label: evidence.label,
          sentiment: evidence.sentiment,
        }))
      : null;
    partDto.useCases = allUseCases.length
      ? allUseCases.map((evidence) => ({
          label: evidence.label,
          sentiment: evidence.sentiment,
        }))
      : null;
    partDto.quotes = (reference.quotes ?? []).map((quote) =>
      toReviewQuoteDto(quote),
    );

    partDto.parentComments = await this.fetchParentComments(comment, platform);

    return partDto;
  }

  private async fetchParentComments(
    comment: UserComment | undefined,
    platform: ThreadPlatform,
  ): Promise<ReviewParentCommentDto[]> {
    if (!comment?.externalId) {
      return [];
    }

    const parentRelation = nameOf<UserComment>("parent");
    const commentWithParents = await this.userCommentRepo.repo.findOne({
      where: { externalId: comment.externalId },
      relations: [
        parentRelation,
        `${parentRelation}.${parentRelation}`,
        `${parentRelation}.${parentRelation}.${parentRelation}`,
      ],
    });

    if (!commentWithParents) {
      return [];
    }

    const ancestors: ReviewParentCommentDto[] = [];
    let current: UserComment | undefined = commentWithParents.parent;

    while (current && ancestors.length < 3) {
      const ancestor = new ReviewParentCommentDto();
      ancestor.body = current.body;
      ancestor.authorName = current.authorName ?? null;
      ancestor.externalUrl = resolveExternalUrl(current.url, platform);
      ancestor.upvotes = current.upvotes;
      ancestor.externalCreationTs = current.externalCreationTs ?? null;
      ancestors.unshift(ancestor);
      current = current.parent;
    }

    return ancestors;
  }
}
