import { Controller, Post, SerializeOptions, UseGuards } from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  ProductModel,
  ProductModelRepository,
  ProductRating,
  ProductRatingRepository,
  UserRole,
} from "@ebike-backend/database";
import { ProductNormalizerService } from "@ebike-backend/product";
import { nameOf } from "@ebike-backend/utils";

@Controller("admin-test")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminTestController {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly productRatingRepo: ProductRatingRepository,
    private readonly productNormalizer: ProductNormalizerService,
  ) {}

  @Post("normalize-products")
  async normalizeAllProducts(): Promise<{ updated: number }> {
    // Fetch all products
    const products = await this.productRepo.find({
      relations: [nameOf<ProductModel>("brand")],
    });

    // Update normalizedName for each product
    products.forEach((product, idx) => {
      product.normalizedName = this.productNormalizer.normalizeProduct({
        brand: product.brand?.name || "",
        model: product.model,
        displayName: product.displayName,
      });

      if (idx % 100 === 0) {
        console.log(`Normalized ${idx} / ${products.length}`);
      }
    });

    // Save all updated products
    await this.productRepo.saveAll(products);

    return { updated: products.length };
  }

  @Post("rerun-product-ratings")
  @SerializeOptions({ strategy: "exposeAll" })
  async rerunAllProductRatings(): Promise<{ queued: number }> {
    const result = await this.productRatingRepo.repo
      .createQueryBuilder()
      .update(ProductRating)
      .set({ updatedAt: new Date("1970-01-01T00:00:00Z") })
      .where(`"modelId" IN (SELECT DISTINCT "modelId" FROM review)`)
      .execute();

    return { queued: result.affected ?? 0 };
  }
}
