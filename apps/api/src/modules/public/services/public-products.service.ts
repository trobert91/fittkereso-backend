import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, SelectQueryBuilder } from "typeorm";
import {
  CommentStatus,
  Depth,
  ExperienceBucket,
  expandExperienceFilters,
  ProductCategory,
  ProductLabelSummary,
  ProductModelRepository,
  ProductRating,
  ReviewRepository,
  ProductReference,
  Review,
  ReviewLabel,
  ReviewLabelType,
  Intent,
  Sentiment,
  ProductModel,
  ProductReferenceCandidate,
  UserComment,
} from "@ebike-backend/database";
import { RATING_DEFAULTS } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { ProductImageDtoService } from "@ebike-backend/product";
import { nameOf } from "@ebike-backend/utils";

import { ProductListDto } from "../dto/product-list.dto";
import {
  ProductDetailDto,
  ProductImageDto,
  ShopLinkDto,
} from "../dto/product-detail.dto";
import { ContextScoreDto } from "../dto/context-score.dto";
import { BrandDto } from "../dto/brand.dto";
import { MainImageDto } from "../dto/main-image.dto";
import {
  ProductLabelSummaryDto,
  ProductRatingDto,
} from "../dto/product-rating.dto";
import { CategoryListDto, FilterFieldDto } from "../dto/category.dto";
import { QuoteDto } from "../dto/quote.dto";
import { ReviewDetailsDto, ReviewDto } from "../dto/review.dto";
import { toReviewQuoteDto } from "./quote-dto.mapper";
import { ReviewSortBy } from "../dto/review-query.dto";
import { ReviewSearchRequestDto } from "../dto/review-search-request.dto";
import { PaginatedReviewResult } from "../dto/paginated-review-result.dto";
import {
  MentionFrequencyQueryDto,
  MentionFrequencyDataPointDto,
  MentionFrequencyResultDto,
} from "../dto/mention-frequency.dto";

const INTENT_LABELS: Record<string, string> = {
  [Intent.Recommendation]: "Recommendation",
  [Intent.IssueReport]: "Issue Report",
  [Intent.Comparison]: "Comparison",
  [Intent.ExperienceReport]: "Experience Report",
  [Intent.Warning]: "Warning",
  [Intent.SeekingAdvice]: "Seeking Advice",
  [Intent.Question]: "Question",
  [Intent.ReputationReport]: "Reputation Report",
};

const SENTIMENT_LABELS: Record<string, string> = {
  [Sentiment.StrongPositive]: "Very positive",
  [Sentiment.Positive]: "Positive",
  [Sentiment.Neutral]: "Neutral",
  [Sentiment.Mixed]: "Mixed",
  [Sentiment.Negative]: "Negative",
  [Sentiment.StrongNegative]: "Very negative",
};

const EXPERIENCE_BUCKET_LABELS: Record<ExperienceBucket, string> = {
  [ExperienceBucket.FirstHand]: "First hand",
  [ExperienceBucket.Speculative]: "Speculative",
};

type ReviewFilterAxis =
  | "sentiment"
  | "intent"
  | "experience"
  | "features"
  | "useCases"
  | "issues";

const POSITIVE_SENTIMENTS = [Sentiment.StrongPositive, Sentiment.Positive];
const NEGATIVE_SENTIMENTS = [Sentiment.StrongNegative, Sentiment.Negative];

function bucketSentiments(
  bucket: "positive" | "negative" | undefined,
): Sentiment[] | null {
  if (bucket === "positive") return POSITIVE_SENTIMENTS;
  if (bucket === "negative") return NEGATIVE_SENTIMENTS;
  return null;
}

@Injectable()
export class PublicProductsService {
  constructor(
    private readonly productModelRepo: ProductModelRepository,
    private readonly reviewRepo: ReviewRepository,
    @InjectDataSource("postgres")
    private readonly dataSource: DataSource,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly productImageDtoService: ProductImageDtoService,
  ) {}

  private getMinReviewScore(): number {
    return (
      this.dynamicConfigService.rating?.minReviewScore ??
      RATING_DEFAULTS.minReviewScore
    );
  }

  async getTopProducts(): Promise<ProductListDto[]> {
    const products = await this.productModelRepo.repo
      .createQueryBuilder("product")
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("brand")}`, "brand")
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("mainImage")}`,
        "mainImage",
      )
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("rating")}`, "rating")
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("productCategory")}`,
        "category",
      )
      .where(`product.${nameOf<ProductModel>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(
        `rating.${nameOf<ProductRating>("totalReviewCount")} >= :minReviews`,
        { minReviews: 10 },
      )
      .orderBy(
        `rating.${nameOf<ProductRating>("rating")}`,
        "DESC",
        "NULLS LAST",
      )
      .limit(30)
      .getMany();

    this.productImageDtoService.updateProductImageUrls(products);
    return products.map((p) => this.toProductListDto(p));
  }

  async getProductBySlug(slug: string): Promise<ProductDetailDto> {
    const product = await this.productModelRepo.repo
      .createQueryBuilder("product")
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("brand")}`, "brand")
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("productCategory")}`,
        "category",
      )
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("images")}`, "images")
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("mainImage")}`,
        "mainImage",
      )
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("aliases")}`,
        "aliases",
      )
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("rating")}`, "rating")
      .where(`product.${nameOf<ProductModel>("slug")} = :slug`, { slug })
      .getOne();

    if (!product) {
      throw new NotFoundException(`Product with slug "${slug}" not found`);
    }

    this.productImageDtoService.updateProductImageUrls([product]);
    const contextScores = await this.computeContextScores(product.id);
    const availableFeatures = this.getAvailableFeatures(product);
    const availableUseCases = this.getAvailableUseCases(product);
    const shopLinks = this.enrichShopLinksWithAffiliateTag([]);

    const dto = new ProductDetailDto();
    dto.id = product.id;
    dto.slug = product.slug ?? "";
    dto.displayName = product.displayName;
    dto.model = product.model;
    dto.releaseYear = product.releaseYear;
    dto.description = product.description;
    dto.specs = product.specs;
    dto.orderedSpecs = product.orderedSpecs;
    dto.aliases = (product.aliases ?? []).map((a) => a.alias);
    dto.contextScores = contextScores;
    dto.shopLinks = shopLinks;
    dto.categorySlug = product.productCategory?.slug ?? "";
    dto.categoryName = product.productCategory?.name ?? "";
    dto.images = (product.images ?? [])
      .sort((a, b) => a.order - b.order)
      .map((img) => {
        const imageDto = new ProductImageDto();
        imageDto.url = img.url ?? "";
        imageDto.order = img.order;
        return imageDto;
      });

    if (product.brand) {
      const brandDto = new BrandDto();
      brandDto.slug = product.brand.slug ?? "";
      brandDto.name = product.brand.name;
      dto.brand = brandDto;
    }

    if (product.mainImage) {
      const mainImageDto = new MainImageDto();
      mainImageDto.url = product.mainImage.url ?? "";
      dto.mainImage = mainImageDto;
    } else {
      dto.mainImage = null;
    }

    if (product.rating) {
      const ratingDto = new ProductRatingDto();
      ratingDto.totalReviewCount = product.rating.totalReviewCount;
      ratingDto.strongPositiveReviewCount =
        product.rating.strongPositiveReviewCount;
      ratingDto.positiveReviewCount = product.rating.positiveReviewCount;
      ratingDto.negativeReviewCount = product.rating.negativeReviewCount;
      ratingDto.strongNegativeReviewCount =
        product.rating.strongNegativeReviewCount;
      ratingDto.neutralReviewCount = product.rating.neutralReviewCount;
      ratingDto.mixedReviewCount = product.rating.mixedReviewCount;
      ratingDto.handsonReviewCount = product.rating.handsonReviewCount;
      ratingDto.averageReviewScore = product.rating.averageReviewScore;
      ratingDto.rating = product.rating.rating;
      ratingDto.tldr = product.rating.tldr ?? null;
      ratingDto.summary = product.rating.summary ?? null;
      ratingDto.pros = product.rating.pros ?? null;
      ratingDto.cons = product.rating.cons ?? null;
      dto.rating = ratingDto;
    } else {
      dto.rating = null;
    }

    dto.featureSummary = this.toLabelSummaryDtos(
      product.rating?.featureSummary,
    );
    dto.issueSummary = this.toLabelSummaryDtos(product.rating?.issueSummary);
    dto.useCaseSummary = this.toLabelSummaryDtos(
      product.rating?.useCaseSummary,
    );

    dto.availableUseCases =
      availableUseCases.length > 0 ? availableUseCases : null;
    dto.availableFeatures =
      availableFeatures.length > 0 ? availableFeatures : null;

    return dto;
  }

  private toLabelSummaryDtos(
    rows?: ProductLabelSummary[] | null,
  ): ProductLabelSummaryDto[] | null {
    if (!rows?.length) return null;
    return rows.map((row) => {
      const dto = new ProductLabelSummaryDto();
      dto.name = row.name;
      dto.mentionCount = row.mentionCount;
      dto.strongPositiveCount = row.strongPositiveCount;
      dto.positiveCount = row.positiveCount;
      dto.neutralCount = row.neutralCount;
      dto.mixedCount = row.mixedCount;
      dto.negativeCount = row.negativeCount;
      dto.strongNegativeCount = row.strongNegativeCount;
      dto.score = row.score;
      dto.headline = row.headline ?? null;
      dto.narrative = row.narrative ?? null;
      dto.narrativeGeneratedAt = row.narrativeGeneratedAt ?? null;
      return dto;
    });
  }

  private getAvailableFeatures(product: ProductModel): string[] {
    return (product.rating?.featureSummary ?? [])
      .map((summary) => summary.name)
      .sort();
  }

  private getAvailableUseCases(product: ProductModel): string[] {
    return (product.rating?.useCaseSummary ?? [])
      .map((summary) => summary.name)
      .sort();
  }

  async computeContextScores(productId: string): Promise<ContextScoreDto[]> {
    const results: {
      intent_value: string;
      positive_count: string;
      total_count: string;
    }[] = await this.reviewRepo.repo.query(
      `
      SELECT
        intent_value,
        COUNT(*) FILTER (WHERE r.sentiment = 'positive') AS positive_count,
        COUNT(*) AS total_count
      FROM review r
      CROSS JOIN LATERAL unnest(r.intents) AS intent_value
      WHERE r."modelId" = $1
        AND r.intents IS NOT NULL
        AND r.enabled = true
        AND r."deletedAt" IS NULL
      GROUP BY intent_value
      HAVING COUNT(*) >= 5
      ORDER BY COUNT(*) DESC
      LIMIT 4
      `,
      [productId],
    );

    return results.map((row) => {
      const total = parseInt(row.total_count, 10);
      const positive = parseInt(row.positive_count, 10);
      const dto = new ContextScoreDto();
      dto.intentSlug = row.intent_value;
      dto.intentLabel = INTENT_LABELS[row.intent_value] ?? row.intent_value;
      dto.recommendationRate =
        total > 0 ? Math.round((positive / total) * 100) : 0;
      dto.reviewCount = total;
      return dto;
    });
  }

  enrichShopLinksWithAffiliateTag(
    links: { url: string; platform: string | null }[],
  ): ShopLinkDto[] {
    const affiliateTag = this.dynamicConfigService.general.amazonAffiliateTag;

    return links.map((link) => {
      let url = link.url;
      if (affiliateTag && link.platform?.toLowerCase() === "amazon") {
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}tag=${affiliateTag}`;
      }
      const dto = new ShopLinkDto();
      dto.url = url;
      dto.platform = link.platform;
      return dto;
    });
  }

  async getMentionFrequency(
    slug: string,
    query: MentionFrequencyQueryDto,
  ): Promise<MentionFrequencyResultDto> {
    const product = await this.productModelRepo.repo.findOne({
      where: { slug },
      select: ["id"],
    });

    if (!product) {
      throw new NotFoundException(`Product with slug "${slug}" not found`);
    }

    const granularity = query.granularity ?? "month";
    const params: (string | Date)[] = [product.id, granularity];
    const conditions: string[] = [];

    if (query.from) {
      params.push(query.from);
      conditions.push(`uc."externalCreationTs" >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`uc."externalCreationTs" <= $${params.length}`);
    }

    const whereClause =
      conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    const rows: {
      date: string;
      count: string;
      positive: string;
      negative: string;
    }[] = await this.dataSource.query(
      `
      SELECT
        DATE_TRUNC($2, uc."externalCreationTs") AS date,
        COUNT(*)::text AS count,
        COUNT(*) FILTER (WHERE pr.sentiment = 'positive')::text AS positive,
        COUNT(*) FILTER (WHERE pr.sentiment = 'negative')::text AS negative
      FROM product_reference pr
      INNER JOIN product_reference_candidate prc ON prc."referenceId" = pr.id
      INNER JOIN user_comment uc ON uc.id = pr."commentId"
      WHERE prc."modelId" = $1
        AND pr.enabled = true
        AND uc.status = 'approved'
        AND uc."externalCreationTs" IS NOT NULL
        ${whereClause}
      GROUP BY DATE_TRUNC($2, uc."externalCreationTs")
      ORDER BY date ASC
      `,
      params,
    );

    const result = new MentionFrequencyResultDto();
    result.dataPoints = rows.map((row) => {
      const dataPoint = new MentionFrequencyDataPointDto();
      dataPoint.date = new Date(row.date).toISOString().split("T")[0];
      dataPoint.count = parseInt(row.count, 10);
      dataPoint.positive = parseInt(row.positive, 10);
      dataPoint.negative = parseInt(row.negative, 10);
      return dataPoint;
    });
    return result;
  }

  async getSimilarProducts(slug: string): Promise<ProductListDto[]> {
    const product = await this.productModelRepo.repo
      .createQueryBuilder("product")
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("productCategory")}`,
        "category",
      )
      .where(`product.${nameOf<ProductModel>("slug")} = :slug`, { slug })
      .getOne();

    if (!product || !product.productCategory) {
      return [];
    }

    const similar = await this.productModelRepo.repo
      .createQueryBuilder("product")
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("brand")}`, "brand")
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("mainImage")}`,
        "mainImage",
      )
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("rating")}`, "rating")
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("productCategory")}`,
        "category",
      )
      .where(`category.${nameOf<ProductCategory>("id")} = :categoryId`, {
        categoryId: product.productCategory.id,
      })
      .andWhere(`product.${nameOf<ProductModel>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(`product.${nameOf<ProductModel>("id")} != :selfId`, {
        selfId: product.id,
      })
      .andWhere(
        `rating.${nameOf<ProductRating>("totalReviewCount")} >= :minReviews`,
        { minReviews: 10 },
      )
      .orderBy(
        `rating.${nameOf<ProductRating>("rating")}`,
        "DESC",
        "NULLS LAST",
      )
      .limit(4)
      .getMany();

    this.productImageDtoService.updateProductImageUrls(similar);
    return similar.map((p) => this.toProductListDto(p));
  }

  async getTopQuotes(): Promise<QuoteDto[]> {
    const topProducts = await this.productModelRepo.repo
      .createQueryBuilder("product")
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("brand")}`, "brand")
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("rating")}`, "rating")
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>("productCategory")}`,
        "category",
      )
      .where(`product.${nameOf<ProductModel>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(
        `rating.${nameOf<ProductRating>("totalReviewCount")} >= :minReviews`,
        { minReviews: 10 },
      )
      .orderBy(
        `rating.${nameOf<ProductRating>("rating")}`,
        "DESC",
        "NULLS LAST",
      )
      .limit(3)
      .getMany();

    const productRefRepo = this.dataSource.getRepository(ProductReference);
    const quotes: QuoteDto[] = [];

    for (const product of topProducts) {
      const reference = await productRefRepo
        .createQueryBuilder("ref")
        // Walk the candidate join to reach the linked review — a candidate row
        // pointing at this product is the multi-candidate equivalent of the
        // old `ref.review` FK.
        .innerJoin(`ref.${nameOf<ProductReference>("candidates")}`, "candidate")
        .innerJoin(
          `candidate.${nameOf<ProductReferenceCandidate>("review")}`,
          "review",
        )
        .innerJoinAndSelect(
          `ref.${nameOf<ProductReference>("comment")}`,
          "comment",
        )
        .where('review."modelId" = :modelId', { modelId: product.id })
        .andWhere('candidate."modelId" = :modelId', { modelId: product.id })
        .andWhere(`review.${nameOf<Review>("sentiment")} IN (:...sentiments)`, {
          sentiments: [Sentiment.StrongPositive, Sentiment.Positive],
        })
        .andWhere(`comment.${nameOf<UserComment>("body")} IS NOT NULL`)
        // Aggregation eligibility — only refs from approved comments and
        // currently-enabled refs reach public surfaces.
        .andWhere(`ref.${nameOf<ProductReference>("enabled")} = true`)
        .andWhere(
          `comment.${nameOf<UserComment>("status")} = :approvedStatus`,
          {
            approvedStatus: CommentStatus.APPROVED,
          },
        )
        .orderBy(
          `comment.${nameOf<UserComment>("upvotes")}`,
          "DESC",
          "NULLS LAST",
        )
        .limit(1)
        .getOne();

      if (reference?.comment) {
        const dto = new QuoteDto();
        dto.productSlug = product.slug ?? "";
        dto.productName = product.displayName;
        dto.categorySlug = product.productCategory?.slug ?? "";
        dto.brandName = product.brand?.name ?? "";
        dto.quote = reference.comment.body;
        dto.upvotes = reference.comment.upvotes ?? 0;
        quotes.push(dto);
      }
    }

    return quotes;
  }

  async searchReviews(
    slug: string,
    query: ReviewSearchRequestDto,
  ): Promise<PaginatedReviewResult> {
    const product = await this.productModelRepo.repo.findOne({
      where: { slug },
      select: ["id"],
    });

    if (!product) {
      throw new NotFoundException(`Product with slug "${slug}" not found`);
    }

    const {
      page = 1,
      pageSize = 20,
      sortBy = ReviewSortBy.upvotes,
      sortDir = "desc",
      includeAggregations = true,
    } = query;

    const qb = this.reviewRepo.repo.createQueryBuilder("review");
    this.applyReviewFilters(qb, product.id, query);

    const direction = sortDir.toUpperCase() as "ASC" | "DESC";
    switch (sortBy) {
      case ReviewSortBy.downvotes:
        qb.orderBy(
          `review.${nameOf<Review>("totalDownvotes")}`,
          direction,
          "NULLS LAST",
        );
        break;
      case ReviewSortBy.creationTs:
        qb.orderBy(
          `review.${nameOf<Review>("externalCreationTs")}`,
          direction,
          "NULLS LAST",
        );
        break;
      case ReviewSortBy.sentiment:
        qb.addSelect(
          `CASE review.${nameOf<Review>("sentiment")}
            WHEN 'strongPositive' THEN 6
            WHEN 'positive' THEN 5
            WHEN 'neutral' THEN 4
            WHEN 'mixed' THEN 3
            WHEN 'negative' THEN 2
            WHEN 'strongNegative' THEN 1
            ELSE 0
          END`,
          "sentiment_order",
        ).orderBy("sentiment_order", direction, "NULLS LAST");
        break;
      case ReviewSortBy.experience:
        qb.addSelect(
          `CASE review.${nameOf<Review>("experience")}
            WHEN 'owner' THEN 5
            WHEN 'prior_owner' THEN 4
            WHEN 'tested' THEN 3
            WHEN 'prospective_buyer' THEN 2
            WHEN 'reference' THEN 1
            ELSE 0
          END`,
          "experience_order",
        ).orderBy("experience_order", direction, "NULLS LAST");
        break;
      case ReviewSortBy.depth:
        qb.addSelect(
          `CASE review.${nameOf<Review>("depth")}
            WHEN 'comprehensive' THEN 4
            WHEN 'detailed' THEN 3
            WHEN 'mentioned' THEN 2
            WHEN 'superficial' THEN 1
            ELSE 0
          END`,
          "depth_order",
        ).orderBy("depth_order", direction, "NULLS LAST");
        break;
      case ReviewSortBy.reviewScore:
        qb.orderBy(
          `review.${nameOf<Review>("reviewScore")}`,
          direction,
          "NULLS LAST",
        );
        break;
      case ReviewSortBy.upvotes:
      default:
        qb.orderBy(
          `review.${nameOf<Review>("totalUpvotes")}`,
          direction,
          "NULLS LAST",
        );
        break;
    }

    const offset = (page - 1) * pageSize;
    qb.skip(offset).take(pageSize);

    const [reviews, total, aggregations] = await Promise.all([
      qb.getMany(),
      qb.getCount(),
      includeAggregations
        ? this.computeReviewAggregations(product.id, query)
        : Promise.resolve<FilterFieldDto[]>([]),
    ]);

    const result = new PaginatedReviewResult();
    result.data = reviews.map((review) => this.toReviewDto(review));
    result.total = total;
    result.page = page;
    result.pageSize = pageSize;
    result.totalPages = Math.ceil(total / pageSize);
    result.aggregations = aggregations;
    return result;
  }

  /**
   * Build the base WHERE for a review query: product + enabled + minReviewScore + deletedAt,
   * plus any of the input filters that are not in `skip`. `skip` lets facet queries drop
   * their own axis so users can see "what other values exist if I clear this filter".
   */
  private applyReviewFilters(
    qb: SelectQueryBuilder<Review>,
    productId: string,
    query: ReviewSearchRequestDto,
    skip: ReadonlySet<ReviewFilterAxis> = new Set(),
  ): void {
    qb.where(`review.${nameOf<Review>("model")}Id = :modelId`, {
      modelId: productId,
    })
      .andWhere(`review.${nameOf<Review>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(`review.${nameOf<Review>("reviewScore")} >= :minReviewScore`, {
        minReviewScore: this.getMinReviewScore(),
      })
      .andWhere(`review.${nameOf<Review>("deletedAt")} IS NULL`);

    const {
      sentiments,
      intents,
      experiences,
      depths,
      creationTsFrom,
      creationTsTo,
      search,
      features,
      featureSentiment,
      useCases,
      useCaseSentiment,
      issues,
    } = query;

    if (!skip.has("sentiment") && sentiments && sentiments.length > 0) {
      qb.andWhere(`review.${nameOf<Review>("sentiment")} IN (:...sentiments)`, {
        sentiments,
      });
    }
    if (!skip.has("intent") && intents && intents.length > 0) {
      qb.andWhere(
        `review.${nameOf<Review>("intents")} && ARRAY[:...intents]::review_intents_enum[]`,
        { intents },
      );
    }
    if (!skip.has("experience") && experiences && experiences.length > 0) {
      const expanded = expandExperienceFilters(experiences);
      if (expanded.length > 0) {
        qb.andWhere(
          `review.${nameOf<Review>("experience")} IN (:...experienceLeaves)`,
          { experienceLeaves: expanded },
        );
      }
    }
    if (depths && depths.length > 0) {
      qb.andWhere(`review.${nameOf<Review>("depth")} IN (:...depths)`, {
        depths,
      });
    }
    if (creationTsFrom) {
      qb.andWhere(`review.${nameOf<Review>("externalCreationTs")} >= :from`, {
        from: creationTsFrom,
      });
    }
    if (creationTsTo) {
      qb.andWhere(`review.${nameOf<Review>("externalCreationTs")} <= :to`, {
        to: creationTsTo,
      });
    }
    if (search) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM product_reference_candidate prc
          INNER JOIN product_reference pr ON pr.id = prc."referenceId"
          INNER JOIN user_comment uc ON uc.id = pr."commentId"
          LEFT JOIN thread t ON t.id = uc."threadId"
          WHERE prc."reviewId" = review.${nameOf<Review>("id")}
          AND (
            LOWER(uc.body) LIKE :searchPattern
            OR t.title ILIKE :searchPattern
            OR t.topic ILIKE :searchPattern
          )
        )`,
        { searchPattern: `%${search.toLowerCase()}%` },
      );
    }
    if (!skip.has("features") && features && features.length > 0) {
      this.applyLabelFilter(
        qb,
        ReviewLabelType.Feature,
        features,
        bucketSentiments(featureSentiment),
        "features",
      );
    }
    if (!skip.has("useCases") && useCases && useCases.length > 0) {
      this.applyLabelFilter(
        qb,
        ReviewLabelType.UseCase,
        useCases,
        bucketSentiments(useCaseSentiment),
        "useCases",
      );
    }
    if (!skip.has("issues") && issues && issues.length > 0) {
      this.applyLabelFilter(qb, ReviewLabelType.Issue, issues, null, "issues");
    }
  }

  private applyLabelFilter(
    qb: SelectQueryBuilder<Review>,
    type: ReviewLabelType,
    labels: string[],
    sentiments: Sentiment[] | null,
    paramPrefix: string,
  ): void {
    const labelsParam = `${paramPrefix}Labels`;
    const typeParam = `${paramPrefix}Type`;
    const sentimentsParam = `${paramPrefix}Sentiments`;

    const sentimentClause = sentiments
      ? `AND rl.${nameOf<ReviewLabel>("sentiment")} IN (:...${sentimentsParam})`
      : "";

    qb.andWhere(
      `EXISTS (
        SELECT 1 FROM review_label rl
        WHERE rl."${nameOf<ReviewLabel>("review")}Id" = review.${nameOf<Review>("id")}
          AND rl.${nameOf<ReviewLabel>("type")} = :${typeParam}
          AND rl.${nameOf<ReviewLabel>("label")} = ANY(:${labelsParam})
          ${sentimentClause}
      )`,
      {
        [labelsParam]: labels.map((label) => label.trim().toLowerCase()),
        [typeParam]: type,
        ...(sentiments ? { [sentimentsParam]: sentiments } : {}),
      },
    );
  }

  private async computeReviewAggregations(
    productId: string,
    query: ReviewSearchRequestDto,
  ): Promise<FilterFieldDto[]> {
    const [sentimentRows, intentRows, experienceRows, featureRows, issueRows] =
      await Promise.all([
        this.aggregateReviewAxis(productId, query, "sentiment"),
        this.aggregateReviewAxis(productId, query, "intent"),
        this.aggregateReviewAxis(productId, query, "experience"),
        this.aggregateLabelAxis(
          productId,
          query,
          ReviewLabelType.Feature,
          "features",
        ),
        this.aggregateLabelAxis(
          productId,
          query,
          ReviewLabelType.Issue,
          "issues",
        ),
      ]);

    const sentiment = new FilterFieldDto();
    sentiment.key = "sentiment";
    sentiment.label = "Sentiment";
    sentiment.type = "multiselect";
    sentiment.options = sentimentRows.map((row) => ({
      value: row.value,
      label: SENTIMENT_LABELS[row.value] ?? row.value,
      count: row.count,
    }));

    const intent = new FilterFieldDto();
    intent.key = "intent";
    intent.label = "Intent";
    intent.type = "multiselect";
    intent.options = intentRows.map((row) => ({
      value: row.value,
      label: INTENT_LABELS[row.value] ?? row.value,
      count: row.count,
    }));

    const experience = new FilterFieldDto();
    experience.key = "experience";
    experience.label = "Experience";
    experience.type = "multiselect";
    experience.options = experienceRows.map((row) => ({
      value: row.value,
      label:
        EXPERIENCE_BUCKET_LABELS[row.value as ExperienceBucket] ?? row.value,
      count: row.count,
    }));

    const features = new FilterFieldDto();
    features.key = "features";
    features.label = "Features";
    features.type = "multiselect";
    features.options = featureRows.map((row) => ({
      value: row.value,
      label: row.value,
      count: row.count,
    }));

    const issues = new FilterFieldDto();
    issues.key = "issues";
    issues.label = "Issues";
    issues.type = "multiselect";
    issues.options = issueRows.map((row) => ({
      value: row.value,
      label: row.value,
      count: row.count,
    }));

    return [sentiment, intent, experience, features, issues];
  }

  private async aggregateReviewAxis(
    productId: string,
    query: ReviewSearchRequestDto,
    axis: ReviewFilterAxis,
  ): Promise<{ value: string; count: number }[]> {
    const base = this.reviewRepo.repo.createQueryBuilder("review");
    this.applyReviewFilters(base, productId, query, new Set([axis]));

    if (axis === "sentiment") {
      base
        .select(`review.${nameOf<Review>("sentiment")}`, "value")
        .addSelect("COUNT(*)::int", "count")
        .groupBy(`review.${nameOf<Review>("sentiment")}`);
    } else if (axis === "experience") {
      base
        .select(
          `CASE
            WHEN review.${nameOf<Review>("experience")} IN ('owner', 'prior_owner', 'tested') THEN '${ExperienceBucket.FirstHand}'
            WHEN review.${nameOf<Review>("experience")} IN ('prospective_buyer', 'reference') THEN '${ExperienceBucket.Speculative}'
            ELSE NULL
          END`,
          "value",
        )
        .addSelect("COUNT(*)::int", "count")
        .groupBy("value");
    } else if (axis === "intent") {
      base
        .select(`UNNEST(review.${nameOf<Review>("intents")})`, "value")
        .addSelect("COUNT(*)::int", "count")
        .groupBy("value");
    }

    const rows = await base.getRawMany<{
      value: string | null;
      count: number;
    }>();
    return rows
      .filter(
        (row): row is { value: string; count: number } =>
          row.value != null && row.value !== "",
      )
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Facet aggregation for label-typed axes (features, issues). Counts the
   * number of distinct reviews matching the current filter set (with the target
   * axis excluded) that carry at least one ReviewLabel of the given type.
   */
  private async aggregateLabelAxis(
    productId: string,
    query: ReviewSearchRequestDto,
    type: ReviewLabelType,
    axis: ReviewFilterAxis,
  ): Promise<{ value: string; count: number }[]> {
    const base = this.reviewRepo.repo.createQueryBuilder("review");
    this.applyReviewFilters(base, productId, query, new Set([axis]));

    base
      .innerJoin(
        ReviewLabel,
        "rl",
        `rl."${nameOf<ReviewLabel>("review")}Id" = review.${nameOf<Review>("id")} AND rl.${nameOf<ReviewLabel>("type")} = :facetType`,
        { facetType: type },
      )
      .select(`rl.${nameOf<ReviewLabel>("label")}`, "value")
      .addSelect("COUNT(DISTINCT review.id)::int", "count")
      .groupBy(`rl.${nameOf<ReviewLabel>("label")}`);

    const rows = await base.getRawMany<{
      value: string | null;
      count: number;
    }>();
    return rows
      .filter(
        (row): row is { value: string; count: number } =>
          row.value != null && row.value !== "",
      )
      .sort((a, b) => b.count - a.count);
  }

  private toReviewDto(review: Review): ReviewDto {
    const dto = new ReviewDto();
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
    if (review.reviewDetails) {
      const detailsDto = new ReviewDetailsDto();
      detailsDto.returned = review.reviewDetails.returned;
      detailsDto.defective = review.reviewDetails.defective;
      detailsDto.multipleUnits = review.reviewDetails.multipleUnits;
      dto.reviewDetails = detailsDto;
    }
    return dto;
  }

  private toProductListDto(product: ProductModel): ProductListDto {
    const dto = new ProductListDto();
    dto.id = product.id;
    dto.slug = product.slug ?? "";
    dto.displayName = product.displayName;
    dto.model = product.model;
    dto.releaseYear = product.releaseYear;
    dto.orderedSpecs = product.orderedSpecs;

    if (product.brand) {
      const brandDto = new BrandDto();
      brandDto.slug = product.brand.slug ?? "";
      brandDto.name = product.brand.name;
      dto.brand = brandDto;
    }

    if (product.productCategory) {
      const categoryDto = new CategoryListDto();
      categoryDto.id = product.productCategory.id;
      categoryDto.slug = product.productCategory.slug ?? "";
      categoryDto.name = product.productCategory.name;
      dto.category = categoryDto;
    }

    if (product.mainImage) {
      const mainImageDto = new MainImageDto();
      mainImageDto.url = product.mainImage.url ?? "";
      dto.mainImage = mainImageDto;
    } else {
      dto.mainImage = null;
    }

    if (product.rating) {
      const ratingDto = new ProductRatingDto();
      ratingDto.totalReviewCount = product.rating.totalReviewCount;
      ratingDto.strongPositiveReviewCount =
        product.rating.strongPositiveReviewCount;
      ratingDto.positiveReviewCount = product.rating.positiveReviewCount;
      ratingDto.negativeReviewCount = product.rating.negativeReviewCount;
      ratingDto.strongNegativeReviewCount =
        product.rating.strongNegativeReviewCount;
      ratingDto.neutralReviewCount = product.rating.neutralReviewCount;
      ratingDto.mixedReviewCount = product.rating.mixedReviewCount;
      ratingDto.handsonReviewCount = product.rating.handsonReviewCount;
      ratingDto.averageReviewScore = product.rating.averageReviewScore;
      ratingDto.rating = product.rating.rating;
      dto.rating = ratingDto;
    } else {
      dto.rating = null;
    }

    return dto;
  }
}
