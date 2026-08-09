import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type { ProductResolutionInput } from "@ebike-backend/database";
import { ProductModel, ProductModelRepository } from "@ebike-backend/database";
import { ProductFuzzySearchService } from "@ebike-backend/product";
import {
  ResolutionOptions,
  ResolutionResult,
  ResolutionService,
  ResolutionThreadContext,
} from "@ebike-backend/resolution";
import { nameOf } from "@ebike-backend/utils";
import { Like } from "typeorm";

@Controller("product-test")
export class ProductTestController {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly fuzzySearch: ProductFuzzySearchService,
    private readonly productSearch: ResolutionService,
  ) {}

  @Get(":id")
  async getProduct(@Param("id") id: string) {
    const product = await this.productRepo.findOne({
      where: { id },
      relations: [
        nameOf<ProductModel>("brand"),
        nameOf<ProductModel>("productCategory"),
        nameOf<ProductModel>("specs"),
        nameOf<ProductModel>("reviews"),
      ],
    });
    return { product };
  }

  @Get("/search/:searchTerm")
  async search(@Param("searchTerm") searchTerm: string) {
    const product = await this.productRepo.findOne({
      where: { displayName: Like(`%${searchTerm}%`) },
      relations: [
        nameOf<ProductModel>("brand"),
        nameOf<ProductModel>("productCategory"),
        nameOf<ProductModel>("specs"),
        nameOf<ProductModel>("reviews"),
      ],
    });
    return { product };
  }

  @Post("/resolve")
  async resolveProduct(
    @Body()
    body: {
      input: ProductResolutionInput;
      options?: {
        webSearchEnabled?: boolean;
        useEmbedding?: boolean;
        mode?: "strict" | "loose";
        threadContext?: ResolutionThreadContext;
      };
    },
  ): Promise<ResolutionResult> {
    if (body.input.searchBefore && !(body.input.searchBefore instanceof Date)) {
      body.input.searchBefore = new Date(body.input.searchBefore as string);
    }

    const options: ResolutionOptions = {
      webSearchEnabled: body.options?.webSearchEnabled ?? false,
      useEmbedding: body.options?.useEmbedding ?? true,
      mode: body.options?.mode ?? "strict",
    };
    const callerContext = body.options?.threadContext
      ? { threadContext: body.options.threadContext }
      : {};

    return this.productSearch.search(
      body.input,
      options,
      callerContext,
      undefined,
      { source: "product-test-controller" },
    );
  }
}
