import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  SerializeOptions,
} from "@nestjs/common";
import { SerializeGroup } from "@ebike-backend/utils";
import { PublicProductsService } from "../services/public-products.service";
import { ProductListDto } from "../dto/product-list.dto";
import { ProductDetailDto } from "../dto/product-detail.dto";
import { QuoteDto } from "../dto/quote.dto";
import { ReviewSearchRequestDto } from "../dto/review-search-request.dto";
import { PaginatedReviewResult } from "../dto/paginated-review-result.dto";
import {
  MentionFrequencyQueryDto,
  MentionFrequencyResultDto,
} from "../dto/mention-frequency.dto";

@Controller("v1/public/products")
@SerializeOptions({ groups: [SerializeGroup.list, SerializeGroup.details] })
export class PublicProductsController {
  constructor(private readonly productsService: PublicProductsService) {}

  @Get("top")
  async getTopProducts(): Promise<ProductListDto[]> {
    return this.productsService.getTopProducts();
  }

  @Get("top/quotes")
  async getTopQuotes(): Promise<QuoteDto[]> {
    return this.productsService.getTopQuotes();
  }

  @Get(":slug/mention-frequency")
  async getMentionFrequency(
    @Param("slug") slug: string,
    @Query() query: MentionFrequencyQueryDto,
  ): Promise<MentionFrequencyResultDto> {
    return this.productsService.getMentionFrequency(slug, query);
  }

  @Get(":slug")
  async getProductBySlug(
    @Param("slug") slug: string,
  ): Promise<ProductDetailDto> {
    return this.productsService.getProductBySlug(slug);
  }

  @Post(":slug/reviews/search")
  async searchReviews(
    @Param("slug") slug: string,
    @Body() body: ReviewSearchRequestDto,
  ): Promise<PaginatedReviewResult> {
    return this.productsService.searchReviews(slug, body);
  }

  @Get(":slug/similar")
  async getSimilarProducts(
    @Param("slug") slug: string,
  ): Promise<ProductListDto[]> {
    return this.productsService.getSimilarProducts(slug);
  }
}
