import { Injectable } from "@nestjs/common";
import {
  ProductModel,
  ProductModelRepository,
  ScrapeTask,
} from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { nameOf } from "@ebike-backend/utils";
import { ProductImageDtoService } from "./product-image-dto.service";

@Injectable()
export class ProductDetailService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly imageDtoService: ProductImageDtoService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async getProductById(productId: string): Promise<ProductModel> {
    const product = await this.productRepo.findOneOrFail({
      where: { id: productId },
      relations: [
        nameOf<ProductModel>("brand"),
        nameOf<ProductModel>("productCategory"),
        nameOf<ProductModel>("aliases"),
        nameOf<ProductModel>("reviews"),
        nameOf<ProductModel>("images"),
        nameOf<ProductModel>("mainImage"),
        nameOf<ProductModel>("rating"),
        nameOf<ProductModel>("sources"),
        nameOf<ProductModel>("scrapeTasks"),
        `scrapeTasks.${nameOf<ScrapeTask>("source")}`,
      ],
      order: {
        scrapeTasks: { createdAt: "DESC" },
      },
    });

    this.imageDtoService.updateProductImageUrls([product]);
    this.attachCategorySchemas(product);

    return product;
  }

  private attachCategorySchemas(product: ProductModel): void {
    const slug = product.productCategory?.slug;
    if (!slug) {
      return;
    }

    product.productCategory!.jsonSchema =
      this.categoryConfigService.getJsonSchema(slug);
    product.productCategory!.uiSchema =
      this.categoryConfigService.getUiSchema(slug);
  }
}
