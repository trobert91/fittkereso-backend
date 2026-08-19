import { Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, RoleGuard, Roles } from '@fittkereso-backend/auth';
import {
  ProductModel,
  ProductModelRepository,
  UserRole,
} from '@fittkereso-backend/database';
import { ProductNormalizerService } from '@fittkereso-backend/product';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { nameOf } from '@fittkereso-backend/utils';

@Controller('admin-test')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminTestController {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly productNormalizer: ProductNormalizerService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  @Post('normalize-products')
  async normalizeAllProducts(): Promise<{ updated: number }> {
    // Fetch all products
    const products = await this.productRepo.find({
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
      ],
    });

    // Update normalizedName for each product
    products.forEach((product, idx) => {
      const strategy =
        this.categoryConfigService.getConfig(product.productCategory?.slug)
          ?.normalizationStrategy ?? 'digit-heuristic';
      product.normalizedName = this.productNormalizer.normalizeProduct({
        brand: product.brand?.name || '',
        model: product.model,
        displayName: product.displayName,
        strategy,
      });

      if (idx % 100 === 0) {
        console.log(`Normalized ${idx} / ${products.length}`);
      }
    });

    // Save all updated products
    await this.productRepo.saveAll(products);

    return { updated: products.length };
  }
}
