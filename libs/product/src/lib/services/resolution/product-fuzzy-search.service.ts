import { Injectable } from '@nestjs/common';
import { chain, isEmpty } from 'lodash';
import {
  Brand,
  ProductAlias,
  ProductModelRepository,
  ProductAliasRepository,
  WithSimilarity,
  ProductModel,
} from '@fittkereso-backend/database';
import {
  nameOf,
  normalize,
  normalizeModelName,
} from '@fittkereso-backend/utils';
import { ProductNormalizerService } from '../product-normalizer.service';
import type { CandidateSearchInput } from './candidate-search-input';

@Injectable()
export class ProductFuzzySearchService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly productAliasRepo: ProductAliasRepository,
    private readonly productNormalizerService: ProductNormalizerService,
  ) {}

  /**
   * Fuzzy search for product models using candidate search input.
   * When categoryIds are provided, the search is strictly scoped to those categories —
   * no unfiltered fallback. Pass undefined to search across all categories.
   */
  public async search(
    searchInput: CandidateSearchInput,
    categoryIds: string[] | undefined,
  ): Promise<WithSimilarity<ProductModel>[]> {
    const results = await this.doSearch({
      searchInput,
      useCategories: !isEmpty(categoryIds),
      categoryIds,
    });

    // Deduplicate by ID in case multiple inputs overlap
    return chain(results)
      .orderBy((c) => c.similarity, 'desc')
      .sortedUniqBy((c) => c.entity.id)
      .take(4)
      .value();
  }

  private async doSearch({
    searchInput,
    useCategories,
    categoryIds,
  }: {
    searchInput: CandidateSearchInput;
    useCategories: boolean;
    categoryIds: string[] | undefined;
  }): Promise<WithSimilarity<ProductModel>[]> {
    const input = searchInput.input;
    if (!input.displayName && !input.model) return [];

    const normalizedName = this.productNormalizerService.normalizeProduct({
      brand: searchInput.brand?.name ?? input.brand!,
      model: input.model,
      displayName: input.displayName,
    });
    const aliasInput = normalize(
      normalizeModelName(input.model ?? input.displayName ?? 'unknown'),
    );
    const modelInput = input.model ?? input.displayName ?? 'unknown';

    const normalizedNameColumn = `product.${nameOf<ProductModel>('normalizedName')}`;
    const aliasColumn = `alias.${nameOf<ProductAlias>('alias')}`;
    const modelColumn = `product.${nameOf<ProductModel>('model')}`;
    let queryBuilder = this.productRepo.repo
      .createQueryBuilder('product')
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('brand')}`, 'brand')
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('productCategory')}`,
        'category',
      )
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('aliases')}`, 'alias')
      .addSelect(
        `similarity(${normalizedNameColumn}, :normalizedName)`,
        'similarity',
      )
      .addSelect(`similarity(${aliasColumn}, :aliasInput)`, 'alias_similarity')
      .addSelect(`similarity(${modelColumn}, :modelInput)`, 'model_similarity')
      .where(`similarity(${normalizedNameColumn}, :normalizedName) > 0.4`)
      .orWhere(`similarity(${aliasColumn}, :aliasInput) > 0.4`)
      .orWhere(`similarity(${modelColumn}, :modelInput) > 0.4`)
      .setParameters({ normalizedName, aliasInput, modelInput });

    if (searchInput.brand) {
      queryBuilder = queryBuilder.andWhere(
        `brand.${nameOf<Brand>('id')} = :brandId`,
        {
          brandId: searchInput.brand?.id,
        },
      );
    }

    if (useCategories && !isEmpty(categoryIds)) {
      queryBuilder = queryBuilder.andWhere(
        'product.productCategoryId IN (:...categoryIds)',
        {
          categoryIds,
        },
      );
    }

    const { entities, raw } = await queryBuilder
      .orderBy('similarity', 'DESC')
      .limit(5)
      .getRawAndEntities();

    return entities.map((entity, idx) => ({
      entity,
      similarity: Math.max(
        parseFloat(raw[idx].similarity ?? 0),
        parseFloat(raw[idx].alias_similarity ?? 0),
        parseFloat(raw[idx].model_similarity ?? 0),
      ),
    }));
  }
}
