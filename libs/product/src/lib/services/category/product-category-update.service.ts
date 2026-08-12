import { Injectable } from '@nestjs/common';
import {
  ProductCategory,
  ProductCategoryRepository,
  ProductModel,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductSpecSortService } from '../product-spec/product-spec-sort.service';
import { CategoryUpdateDto } from '../../models';
import { CategoryUpdateMapperService } from './category-update-mapper.service';
import { generateSlug } from '@fittkereso-backend/utils';

@Injectable()
export class ProductCategoryUpdateService {
  constructor(
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly productSpecSortService: ProductSpecSortService,
    private readonly mapper: CategoryUpdateMapperService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async updateCategory(
    id: string,
    dto: CategoryUpdateDto,
  ): Promise<ProductCategory> {
    const category = await this.categoryRepo.findOneOrFail({
      where: { id },
    });

    // --- Detect schema change BEFORE applying updates ---
    const oldSchema = category.slug
      ? JSON.stringify(this.categoryConfigService.getJsonSchema(category.slug))
      : undefined;

    // Apply DTO changes (entity fields only — name, enabled)
    this.mapper.mapDtoToEntity(dto, category);

    // Write schema/uiSchema to config files if provided in DTO
    if (category.slug) {
      if (dto.jsonSchema !== undefined) {
        this.categoryConfigService.writeJsonSchema(
          category.slug,
          dto.jsonSchema,
        );
      }
      if (dto.uiSchema !== undefined) {
        this.categoryConfigService.writeUiSchema(category.slug, dto.uiSchema);
      }
    }

    const newSchema = category.slug
      ? JSON.stringify(this.categoryConfigService.getJsonSchema(category.slug))
      : undefined;

    const schemaChanged = oldSchema !== newSchema;

    // Regenerate slug
    await this.generateSlug(category);

    // Save category first
    const saved = await this.categoryRepo.save(category);

    // If schema changed → update all product specs within category
    if (schemaChanged) {
      await this.updateProductSpecsInCategory(saved.id);
    }

    return saved;
  }

  private async generateSlug(entity: ProductCategory): Promise<void> {
    let slug = generateSlug(entity.id, entity.name);
    const existing = await this.categoryRepo.findOne({
      where: { slug },
      select: ['id'],
    });
    if (existing && existing.id !== entity.id) {
      slug = slug + '-' + entity.id.slice(-6);
    }
    entity.slug = slug;
  }

  public async updateProductSpecsInCategory(categoryId: string): Promise<void> {
    const category = await this.categoryRepo.findByIdOrFail(categoryId);
    const products = await this.productRepo.findByCategoryId(categoryId);

    for (const product of products) {
      await this.updateProductSpecs(category, product);
    }

    await this.productRepo.saveAll(products);
  }

  private async updateProductSpecs(
    category: ProductCategory,
    product: ProductModel,
  ): Promise<void> {
    if (!product.specs) {
      return;
    }

    product.orderedSpecs = await this.productSpecSortService.sortSpecs(
      category,
      product.specs,
    );
  }
}
