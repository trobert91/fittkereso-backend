import { ConflictException, Injectable } from '@nestjs/common';
import {
  ProductSource,
  ProductSourceRepository,
  SellerRepository,
} from '@fittkereso-backend/database';
import { SellerProductSourceCreateDto } from '../../models';
import { ProductSourceSellerRulesService } from '../product-source/product-source-seller-rules.service';

@Injectable()
export class SellerProductSourceCreateService {
  constructor(
    private readonly sellerRepo: SellerRepository,
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly sellerRules: ProductSourceSellerRulesService,
  ) {}

  public async createForSeller(
    sellerId: string,
    dto: SellerProductSourceCreateDto,
  ): Promise<ProductSource> {
    const seller = await this.sellerRepo.findOneOrFail({
      where: { id: sellerId },
    });

    const existing = await this.productSourceRepo.findOne({
      where: { name: dto.name },
      select: ['id'],
    });
    if (existing) {
      throw new ConflictException(
        `Product source with name "${dto.name}" already exists`,
      );
    }

    const identifiesProducts = dto.identifiesProducts ?? true;
    const hasAllProducts = dto.hasAllProducts ?? false;
    this.sellerRules.assertCompletenessAllowed({ type: dto.type, hasAllProducts });
    await this.sellerRules.assertKeepsIdentifyingSource({
      next: { sellerId, identifiesProducts },
    });

    let priority: number;
    if (dto.priority === undefined) {
      priority = await this.sellerRules.defaultPriority(sellerId);
    } else {
      priority = dto.priority;
      await this.sellerRules.assertPriorityFree({ sellerId, priority });
    }

    const source = new ProductSource();
    source.name = dto.name;
    // Set once, here. The config format is type-bound and the update service
    // refuses to change it — see ProductSource.type.
    source.type = dto.type;
    source.seller = seller;
    source.priority = priority;
    source.identifiesProducts = identifiesProducts;
    source.hasAllProducts = hasAllProducts;
    source.schedulingEnabled = false;
    source.processingEnabled = false;

    try {
      return await this.productSourceRepo.save(source);
    } catch (error: unknown) {
      throw this.sellerRules.translateSaveError(error, priority);
    }
  }
}
