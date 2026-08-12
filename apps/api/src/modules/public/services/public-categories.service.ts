import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Brand,
  ProductCategory,
  ProductCategoryRepository,
  ProductModelRepository,
  ProductModel,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import type {
  FilterBucket,
  FilterSpecConfig,
  ProductCategoryConfig,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { sumBy } from 'lodash';
import {
  CategoryListDto,
  CategoryDetailDto,
  FilterConfigDto,
  FilterFieldDto,
  FilterOptionDto,
} from '../dto/category.dto';
import { ProductListDto } from '../dto/product-list.dto';
import { BrandDto } from '../dto/brand.dto';
import { MainImageDto } from '../dto/main-image.dto';
import { PaginatedProductResult } from '../dto/paginated-result.dto';
import { ProductQueryDto, SortBy } from '../dto/product-query.dto';
import { ProductImageDtoService } from '@fittkereso-backend/product';

interface FilterWhereSql {
  conditions: string[];
  params: unknown[];
}

@Injectable()
export class PublicCategoriesService {
  constructor(
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly productModelRepo: ProductModelRepository,
    private readonly productImageDtoService: ProductImageDtoService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  async getCategories(): Promise<CategoryListDto[]> {
    const categories = await this.categoryRepo.find({
      where: { enabled: true },
      order: { name: 'ASC' },
    });

    return categories
      .filter((c) => c.slug)
      .map((c) => {
        const dto = new CategoryListDto();
        dto.id = c.id;
        dto.slug = c.slug;
        dto.name = c.name;
        return dto;
      });
  }

  async getCategoryBySlug(slug: string): Promise<CategoryDetailDto> {
    const category = await this.categoryRepo.findOne({
      where: { slug },
    });

    if (!category) {
      throw new NotFoundException(`Category with slug "${slug}" not found`);
    }

    const categorySlug = category.slug;
    const config = categorySlug
      ? this.categoryConfigService.getConfig(categorySlug)
      : undefined;

    const dto = new CategoryDetailDto();
    dto.id = category.id;
    dto.slug = category.slug;
    dto.name = category.name;
    dto.categoryDescription = config?.categoryDescription;
    dto.jsonSchema = categorySlug
      ? this.categoryConfigService.getJsonSchema(categorySlug)
      : undefined;
    dto.uiSchema = categorySlug
      ? this.categoryConfigService.getUiSchema(categorySlug)
      : undefined;
    return dto;
  }

  async getFilterConfig(
    slug: string,
    collectFilters = false,
  ): Promise<FilterConfigDto> {
    const category = await this.categoryRepo.findOne({
      where: { slug },
    });

    if (!category) {
      throw new NotFoundException(`Category with slug "${slug}" not found`);
    }

    const categorySlug = category.slug;
    const config = categorySlug
      ? this.categoryConfigService.getConfig(categorySlug)
      : undefined;

    const dto = new FilterConfigDto();
    dto.jsonSchema = categorySlug
      ? this.categoryConfigService.getJsonSchema(categorySlug)
      : undefined;
    dto.uiSchema = categorySlug
      ? this.categoryConfigService.getUiSchema(categorySlug)
      : undefined;
    dto.primarySpecs = config?.primarySpecs ?? [];

    if (collectFilters) {
      const schema = dto.jsonSchema;
      if (schema?.properties && config) {
        const filterSpecs = this.resolveFilterSpecs(schema, config);
        const [aggregations, brands, totalProducts] = await Promise.all([
          this.aggregateFilterFields(category.id, schema, filterSpecs),
          this.aggregateBrands(category.id),
          this.aggregateTotalProducts(category.id),
        ]);
        dto.aggregations = aggregations;
        dto.brands = brands;
        dto.totalProducts = totalProducts;
      }
    }

    return dto;
  }

  async getCategoryProducts(
    slug: string,
    query: ProductQueryDto,
  ): Promise<PaginatedProductResult> {
    const {
      page = 1,
      pageSize = 20,
      name,
      brand,
      specs,
      sortBy,
      sortDir = 'desc',
    } = query;

    const category = await this.categoryRepo.findOne({
      where: { slug },
    });

    if (!category) {
      throw new NotFoundException(`Category with slug "${slug}" not found`);
    }

    const jsonSchema = category.slug
      ? this.categoryConfigService.getJsonSchema(category.slug)
      : undefined;
    const arraySpecKeys = this.getArraySpecKeys(jsonSchema);

    const qb = this.productModelRepo.repo
      .createQueryBuilder('product')
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('brand')}`, 'brand')
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('mainImage')}`,
        'mainImage',
      )
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('productCategory')}`,
        'category',
      )
      .where(`category.${nameOf<ProductCategory>('slug')} = :slug`, { slug })
      .andWhere(`product.${nameOf<ProductModel>('enabled')} = :enabled`, {
        enabled: true,
      });

    if (brand) {
      const brandSlugs = brand.split(',').map((b) => b.trim());
      qb.andWhere(`brand.${nameOf<Brand>('slug')} IN (:...brandSlugs)`, {
        brandSlugs,
      });
    }

    if (name) {
      qb.andWhere(
        `(product."${nameOf<ProductModel>('displayName')}" ILIKE :namePattern OR brand.${nameOf<Brand>('name')} ILIKE :namePattern)`,
        { namePattern: `%${name}%` },
      );
    }

    if (specs) {
      let specIdx = 0;
      for (const [key, value] of Object.entries(specs)) {
        if (typeof value === 'object' && value !== null) {
          if (value.min !== undefined) {
            qb.andWhere(
              `(product.specs->>:specKey${specIdx})::numeric >= :specMin${specIdx}`,
              {
                [`specKey${specIdx}`]: key,
                [`specMin${specIdx}`]: Number(value.min),
              },
            );
          }
          if (value.max !== undefined) {
            qb.andWhere(
              `(product.specs->>:specKeyMax${specIdx})::numeric <= :specMax${specIdx}`,
              {
                [`specKeyMax${specIdx}`]: key,
                [`specMax${specIdx}`]: Number(value.max),
              },
            );
          }
        } else if (typeof value === 'string') {
          if (value === 'true' || value === 'false') {
            qb.andWhere(
              `(product.specs->>:specKey${specIdx})::boolean = :specVal${specIdx}`,
              {
                [`specKey${specIdx}`]: key,
                [`specVal${specIdx}`]: value === 'true',
              },
            );
          } else if (value.includes(',') || value.includes('-')) {
            const values = value.split(',').map((v) => v.trim());
            const bucketRanges = values.filter((v) => v.includes('-'));
            const exactValues = values.filter((v) => !v.includes('-'));

            const conditions: string[] = [];
            const params: Record<string, unknown> = {
              [`specKey${specIdx}`]: key,
            };

            if (exactValues.length > 0) {
              if (arraySpecKeys.has(key)) {
                exactValues.forEach((v, i) => {
                  conditions.push(
                    `product.specs->:specKey${specIdx} ? :arrayVal${specIdx}_${i}`,
                  );
                  params[`arrayVal${specIdx}_${i}`] = v;
                });
              } else {
                conditions.push(
                  `product.specs->>:specKey${specIdx} IN (:...exactVals${specIdx})`,
                );
                params[`exactVals${specIdx}`] = exactValues;
              }
            }

            for (
              let bucketIdx = 0;
              bucketIdx < bucketRanges.length;
              bucketIdx++
            ) {
              const [minStr, maxStr] = bucketRanges[bucketIdx].split('-');
              const rangeConditions: string[] = [];
              if (minStr !== '') {
                rangeConditions.push(
                  `(product.specs->>:specKey${specIdx})::numeric >= :bucketMin${specIdx}_${bucketIdx}`,
                );
                params[`bucketMin${specIdx}_${bucketIdx}`] = Number(minStr);
              }
              if (maxStr !== '') {
                rangeConditions.push(
                  `(product.specs->>:specKey${specIdx})::numeric <= :bucketMax${specIdx}_${bucketIdx}`,
                );
                params[`bucketMax${specIdx}_${bucketIdx}`] = Number(maxStr);
              }
              if (rangeConditions.length > 0) {
                conditions.push(`(${rangeConditions.join(' AND ')})`);
              }
            }

            if (conditions.length > 0) {
              qb.andWhere(`(${conditions.join(' OR ')})`, params);
            }
          } else if (arraySpecKeys.has(key)) {
            qb.andWhere(
              `product.specs->:specKey${specIdx} ? :specVal${specIdx}`,
              { [`specKey${specIdx}`]: key, [`specVal${specIdx}`]: value },
            );
          } else {
            qb.andWhere(
              `product.specs->>:specKey${specIdx} = :specVal${specIdx}`,
              { [`specKey${specIdx}`]: key, [`specVal${specIdx}`]: value },
            );
          }
        }
        specIdx++;
      }
    }

    const direction = sortDir.toUpperCase() as 'ASC' | 'DESC';
    switch (sortBy) {
      case SortBy.releaseYear:
        qb.orderBy(
          `product.${nameOf<ProductModel>('releaseYear')}`,
          direction,
          'NULLS LAST',
        );
        break;
      default:
        qb.orderBy(
          `product.${nameOf<ProductModel>('createdAt')}`,
          direction,
          'NULLS LAST',
        );
        break;
    }

    const paginationOffset = (page - 1) * pageSize;
    qb.offset(paginationOffset).limit(pageSize);

    const [products, total] = await qb.getManyAndCount();

    this.productImageDtoService.updateProductImageUrls(products);
    const result = new PaginatedProductResult();
    result.data = products.map((p) => this.toProductListDto(p));
    result.total = total;
    result.page = page;
    result.pageSize = pageSize;
    result.totalPages = Math.ceil(total / pageSize);

    // Compute faceted aggregations alongside the product list
    const categorySlug = category.slug;
    const schema = categorySlug
      ? this.categoryConfigService.getJsonSchema(categorySlug)
      : undefined;
    const config = categorySlug
      ? this.categoryConfigService.getConfig(categorySlug)
      : undefined;
    if (schema?.properties && config) {
      const filterSpecs = this.resolveFilterSpecs(schema, config);
      if (filterSpecs.length > 0) {
        const [aggregations, brands] = await Promise.all([
          this.aggregateFilterFields(
            category.id,
            schema,
            filterSpecs,
            query,
            arraySpecKeys,
          ),
          this.aggregateBrands(category.id, query, arraySpecKeys),
        ]);
        result.aggregations = aggregations;
        result.brands = brands;
      }
    }

    return result;
  }

  // ─── Aggregation ────────────────────────────────────────────────────────────

  private getArraySpecKeys(
    schema: SpecDefinitionJsonSchema | undefined,
  ): Set<string> {
    if (!schema?.properties) return new Set();
    return new Set(
      Object.entries(schema.properties)
        .filter(([, def]) => def.type === 'array')
        .map(([key]) => key),
    );
  }

  private resolveFilterSpecs(
    schema: SpecDefinitionJsonSchema,
    config: ProductCategoryConfig,
  ): FilterSpecConfig[] {
    if (!config.filterSpecs || config.filterSpecs.length === 0) {
      return [];
    }
    return config.filterSpecs.filter((spec) => spec.key in schema.properties);
  }

  /**
   * Build raw SQL WHERE conditions from ProductQueryDto for use in aggregation queries.
   * Uses positional parameters starting from $startParam.
   * excludeSpecKey: omit this spec from the WHERE (for faceted counting of that spec).
   * excludeBrand: omit brand filter (for faceted counting of brands).
   */
  private buildFilterWhereSql(
    query: ProductQueryDto,
    startParam: number,
    options?: {
      excludeSpecKey?: string;
      excludeBrand?: boolean;
      arraySpecKeys?: Set<string>;
    },
  ): FilterWhereSql {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = startParam;

    if (query.brand && !options?.excludeBrand) {
      const brandSlugs = query.brand.split(',').map((b) => b.trim());
      const placeholders = brandSlugs.map(() => `$${paramIdx++}`).join(', ');
      conditions.push(
        `product.id IN (SELECT pm.id FROM product_model pm INNER JOIN brand b ON b.id = pm."brandId" WHERE b.slug IN (${placeholders}))`,
      );
      params.push(...brandSlugs);
    }

    if (query.name) {
      conditions.push(
        `(product."displayName" ILIKE $${paramIdx} OR EXISTS (SELECT 1 FROM brand b WHERE b.id = product."brandId" AND b.name ILIKE $${paramIdx}))`,
      );
      params.push(`%${query.name}%`);
      paramIdx++;
    }

    if (query.specs) {
      for (const [key, value] of Object.entries(query.specs)) {
        if (key === options?.excludeSpecKey) continue;

        if (typeof value === 'object' && value !== null) {
          if (value.min !== undefined) {
            conditions.push(
              `(product.specs->>$${paramIdx})::numeric >= $${paramIdx + 1}`,
            );
            params.push(key, Number(value.min));
            paramIdx += 2;
          }
          if (value.max !== undefined) {
            conditions.push(
              `(product.specs->>$${paramIdx})::numeric <= $${paramIdx + 1}`,
            );
            params.push(key, Number(value.max));
            paramIdx += 2;
          }
        } else if (typeof value === 'string') {
          if (value === 'true' || value === 'false') {
            conditions.push(
              `(product.specs->>$${paramIdx})::boolean = $${paramIdx + 1}`,
            );
            params.push(key, value === 'true');
            paramIdx += 2;
          } else if (value.includes(',') || value.includes('-')) {
            const values = value.split(',').map((v) => v.trim());
            const bucketRanges = values.filter((v) => v.includes('-'));
            const exactValues = values.filter((v) => !v.includes('-'));

            const orConditions: string[] = [];
            const keyParam = paramIdx++;
            params.push(key);

            if (exactValues.length > 0) {
              if (options?.arraySpecKeys?.has(key)) {
                for (const v of exactValues) {
                  orConditions.push(
                    `product.specs->$${keyParam} ? $${paramIdx++}`,
                  );
                  params.push(v);
                }
              } else {
                const placeholders = exactValues
                  .map(() => `$${paramIdx++}`)
                  .join(', ');
                orConditions.push(
                  `product.specs->>$${keyParam} IN (${placeholders})`,
                );
                params.push(...exactValues);
              }
            }

            for (const bucketRange of bucketRanges) {
              const [minStr, maxStr] = bucketRange.split('-');
              const rangeConditions: string[] = [];
              if (minStr !== '') {
                rangeConditions.push(
                  `(product.specs->>$${keyParam})::numeric >= $${paramIdx}`,
                );
                params.push(Number(minStr));
                paramIdx++;
              }
              if (maxStr !== '') {
                rangeConditions.push(
                  `(product.specs->>$${keyParam})::numeric <= $${paramIdx}`,
                );
                params.push(Number(maxStr));
                paramIdx++;
              }
              if (rangeConditions.length > 0) {
                orConditions.push(`(${rangeConditions.join(' AND ')})`);
              }
            }

            if (orConditions.length > 0) {
              conditions.push(`(${orConditions.join(' OR ')})`);
            }
          } else if (options?.arraySpecKeys?.has(key)) {
            conditions.push(`product.specs->$${paramIdx} ? $${paramIdx + 1}`);
            params.push(key, value);
            paramIdx += 2;
          } else {
            conditions.push(`product.specs->>$${paramIdx} = $${paramIdx + 1}`);
            params.push(key, value);
            paramIdx += 2;
          }
        }
      }
    }

    return { conditions, params };
  }

  private buildFilterWhereSuffix(
    query: ProductQueryDto,
    startParam: number,
    options?: {
      excludeSpecKey?: string;
      excludeBrand?: boolean;
      arraySpecKeys?: Set<string>;
    },
  ): { sql: string; params: unknown[] } {
    const { conditions, params } = this.buildFilterWhereSql(
      query,
      startParam,
      options,
    );
    if (conditions.length === 0) return { sql: '', params: [] };
    return { sql: ' AND ' + conditions.join(' AND '), params };
  }

  private async aggregateFilterFields(
    categoryId: string,
    schema: SpecDefinitionJsonSchema,
    filterSpecs: FilterSpecConfig[],
    query?: ProductQueryDto,
    arraySpecKeys?: Set<string>,
  ): Promise<FilterFieldDto[]> {
    const booleanSpecs = filterSpecs.filter(
      (spec) => spec.filterType === 'boolean',
    );
    const rangeSpecs = filterSpecs.filter(
      (spec) => spec.filterType === 'range',
    );
    const multiselectSpecs = filterSpecs.filter(
      (spec) => spec.filterType === 'multiselect',
    );

    const promises: Promise<void>[] = [];
    const fieldMap = new Map<string, FilterFieldDto>();

    for (const spec of filterSpecs) {
      const property = schema.properties[spec.key];
      if (!property) continue;
      const field = new FilterFieldDto();
      field.key = spec.key;
      field.label = property.title ?? spec.key;
      field.type = spec.filterType;
      field.unit = property.meta?.unit;
      field.openByDefault = spec.openByDefault;
      fieldMap.set(spec.key, field);
    }

    if (booleanSpecs.length > 0 || rangeSpecs.length > 0) {
      promises.push(
        this.aggregateBooleanAndRangeFields(
          categoryId,
          booleanSpecs,
          rangeSpecs,
          fieldMap,
          query,
          arraySpecKeys,
        ),
      );
    }

    for (const spec of multiselectSpecs) {
      const property = schema.properties[spec.key];
      const isArray = property?.type === 'array';
      promises.push(
        (async () => {
          const field = fieldMap.get(spec.key);
          if (!field) return;
          if (spec.buckets?.length) {
            field.options = await this.aggregateBuckets(
              categoryId,
              spec.key,
              spec.buckets,
              query,
              arraySpecKeys,
            );
          } else if (isArray) {
            field.options = await this.aggregateArrayValues(
              categoryId,
              spec.key,
              query,
              arraySpecKeys,
            );
          } else {
            field.options = await this.aggregateDistinctValues(
              categoryId,
              spec.key,
              query,
              arraySpecKeys,
            );
          }
          if (field.options?.length) {
            field.totalCount = sumBy(field.options, 'count');
          }
        })(),
      );
    }

    await Promise.all(promises);

    return filterSpecs
      .map((spec) => fieldMap.get(spec.key))
      .filter((field): field is FilterFieldDto => {
        if (!field) return false;
        if (field.type === 'boolean') return (field.totalCount ?? 0) > 0;
        if (field.type === 'range') return field.range != null;
        if (field.type === 'multiselect')
          return (field.options?.length ?? 0) > 0;
        return false;
      });
  }

  private async aggregateBooleanAndRangeFields(
    categoryId: string,
    booleanSpecs: FilterSpecConfig[],
    rangeSpecs: FilterSpecConfig[],
    fieldMap: Map<string, FilterFieldDto>,
    query?: ProductQueryDto,
    arraySpecKeys?: Set<string>,
  ): Promise<void> {
    const selectClauses: string[] = [];

    for (const spec of booleanSpecs) {
      const key = spec.key;
      selectClauses.push(
        `COUNT(*) FILTER (WHERE (specs->>'${key}')::boolean = true)::int AS "${key}_true"`,
        `COUNT(*) FILTER (WHERE specs->>'${key}' IS NOT NULL)::int AS "${key}_total"`,
      );
    }

    for (const spec of rangeSpecs) {
      const key = spec.key;
      selectClauses.push(
        `MIN((specs->>'${key}')::numeric) AS "${key}_min"`,
        `MAX((specs->>'${key}')::numeric) AS "${key}_max"`,
        `COUNT(*) FILTER (WHERE specs->>'${key}' IS NOT NULL)::int AS "${key}_total"`,
      );
    }

    if (selectClauses.length === 0) return;

    const filterSuffix = query
      ? this.buildFilterWhereSuffix(query, 2, { arraySpecKeys })
      : { sql: '', params: [] };

    const row = await this.productModelRepo.repo.query(
      `SELECT ${selectClauses.join(', ')}
       FROM product_model product
       WHERE product."productCategoryId" = $1 AND product.enabled = true${filterSuffix.sql}`,
      [categoryId, ...filterSuffix.params],
    );

    if (!row?.[0]) return;
    const result = row[0];

    for (const spec of booleanSpecs) {
      const field = fieldMap.get(spec.key);
      if (!field) continue;
      field.trueCount = Number(result[`${spec.key}_true`] ?? 0);
      field.totalCount = Number(result[`${spec.key}_total`] ?? 0);
    }

    for (const spec of rangeSpecs) {
      const field = fieldMap.get(spec.key);
      if (!field) continue;
      const min = result[`${spec.key}_min`];
      const max = result[`${spec.key}_max`];
      const total = Number(result[`${spec.key}_total`] ?? 0);
      if (min != null && total > 0) {
        field.range = { min: Number(min), max: Number(max) };
        field.totalCount = total;
      }
    }
  }

  private async aggregateDistinctValues(
    categoryId: string,
    specKey: string,
    query?: ProductQueryDto,
    arraySpecKeys?: Set<string>,
  ): Promise<FilterOptionDto[]> {
    const filterSuffix = query
      ? this.buildFilterWhereSuffix(query, 3, {
          excludeSpecKey: specKey,
          arraySpecKeys,
        })
      : { sql: '', params: [] };

    const rows: { value: string; count: string }[] =
      await this.productModelRepo.repo.query(
        `SELECT product.specs->>$2 AS value, COUNT(*)::int AS count
       FROM product_model product
       WHERE product."productCategoryId" = $1
         AND product.enabled = true
         AND product.specs->>$2 IS NOT NULL
         AND product.specs->>$2 != ''${filterSuffix.sql}
       GROUP BY product.specs->>$2
       ORDER BY count DESC`,
        [categoryId, specKey, ...filterSuffix.params],
      );

    return rows.map((row) => ({
      value: row.value,
      label: row.value,
      count: Number(row.count),
    }));
  }

  private async aggregateBuckets(
    categoryId: string,
    specKey: string,
    buckets: FilterBucket[],
    query?: ProductQueryDto,
    arraySpecKeys?: Set<string>,
  ): Promise<FilterOptionDto[]> {
    const whenClauses = buckets
      .map((bucket, index) => {
        const conditions: string[] = [];
        if (bucket.min !== undefined) {
          conditions.push(`val >= ${Number(bucket.min)}`);
        }
        if (bucket.max !== undefined) {
          conditions.push(`val <= ${Number(bucket.max)}`);
        }
        return `WHEN ${conditions.join(' AND ')} THEN ${index}`;
      })
      .join(' ');

    const filterSuffix = query
      ? this.buildFilterWhereSuffix(query, 3, {
          excludeSpecKey: specKey,
          arraySpecKeys,
        })
      : { sql: '', params: [] };

    const rows: { bucketIndex: string; count: string }[] =
      await this.productModelRepo.repo.query(
        `SELECT bucket_index AS "bucketIndex", COUNT(*)::int AS count
       FROM (
         SELECT CASE ${whenClauses} ELSE -1 END AS bucket_index
         FROM product_model product,
              LATERAL (SELECT (product.specs->>$2)::numeric AS val) parsed
         WHERE product."productCategoryId" = $1
           AND product.enabled = true
           AND product.specs->>$2 IS NOT NULL${filterSuffix.sql}
       ) bucketed
       WHERE bucket_index >= 0
       GROUP BY bucket_index
       ORDER BY bucket_index`,
        [categoryId, specKey, ...filterSuffix.params],
      );

    const countMap = new Map(
      rows.map((row) => [Number(row.bucketIndex), Number(row.count)]),
    );

    return buckets.map((bucket, index) => {
      const count = countMap.get(index) ?? 0;
      const minPart = bucket.min !== undefined ? String(bucket.min) : '';
      const maxPart = bucket.max !== undefined ? String(bucket.max) : '';
      return {
        value: `${minPart}-${maxPart}`,
        label: bucket.label,
        count,
      };
    });
  }

  private async aggregateArrayValues(
    categoryId: string,
    specKey: string,
    query?: ProductQueryDto,
    arraySpecKeys?: Set<string>,
  ): Promise<FilterOptionDto[]> {
    const filterSuffix = query
      ? this.buildFilterWhereSuffix(query, 3, {
          excludeSpecKey: specKey,
          arraySpecKeys,
        })
      : { sql: '', params: [] };

    const rows: { value: string; count: string }[] =
      await this.productModelRepo.repo.query(
        `SELECT element AS value, COUNT(DISTINCT product.id)::int AS count
       FROM product_model product,
            LATERAL jsonb_array_elements_text(product.specs->$2) AS element
       WHERE product."productCategoryId" = $1
         AND product.enabled = true
         AND jsonb_typeof(product.specs->$2) = 'array'${filterSuffix.sql}
       GROUP BY element
       ORDER BY count DESC`,
        [categoryId, specKey, ...filterSuffix.params],
      );

    return rows.map((row) => ({
      value: row.value,
      label: row.value,
      count: Number(row.count),
    }));
  }

  private async aggregateBrands(
    categoryId: string,
    query?: ProductQueryDto,
    arraySpecKeys?: Set<string>,
  ): Promise<FilterOptionDto[]> {
    const filterSuffix = query
      ? this.buildFilterWhereSuffix(query, 2, {
          excludeBrand: true,
          arraySpecKeys,
        })
      : { sql: '', params: [] };

    const rows: { value: string; label: string; count: string }[] =
      await this.productModelRepo.repo.query(
        `SELECT b.slug AS value, b.name AS label, COUNT(*)::int AS count
         FROM product_model product
         INNER JOIN brand b ON b.id = product."brandId"
         WHERE product."productCategoryId" = $1
           AND product.enabled = true${filterSuffix.sql}
         GROUP BY b.slug, b.name
         ORDER BY count DESC`,
        [categoryId, ...filterSuffix.params],
      );

    return rows.map((row) => ({
      value: row.value,
      label: row.label,
      count: Number(row.count),
    }));
  }

  private async aggregateTotalProducts(
    categoryId: string,
    query?: ProductQueryDto,
    arraySpecKeys?: Set<string>,
  ): Promise<number> {
    const filterSuffix = query
      ? this.buildFilterWhereSuffix(query, 2, { arraySpecKeys })
      : { sql: '', params: [] };

    const row = await this.productModelRepo.repo.query(
      `SELECT COUNT(*)::int AS "totalProducts"
       FROM product_model product
       WHERE product."productCategoryId" = $1
         AND product.enabled = true${filterSuffix.sql}`,
      [categoryId, ...filterSuffix.params],
    );

    return Number(row?.[0]?.totalProducts ?? 0);
  }

  // ─── DTO Mapping ────────────────────────────────────────────────────────────

  private toProductListDto(product: ProductModel): ProductListDto {
    const dto = new ProductListDto();
    dto.id = product.id;
    dto.slug = product.slug ?? '';
    dto.displayName = product.displayName;
    dto.model = product.model;
    dto.releaseYear = product.releaseYear;
    dto.orderedSpecs = product.orderedSpecs;

    if (product.brand) {
      const brandDto = new BrandDto();
      brandDto.slug = product.brand.slug ?? '';
      brandDto.name = product.brand.name;
      dto.brand = brandDto;
    }

    if (product.productCategory) {
      const categoryDto = new CategoryListDto();
      categoryDto.id = product.productCategory.id;
      categoryDto.slug = product.productCategory.slug ?? '';
      categoryDto.name = product.productCategory.name;
      dto.category = categoryDto;
    }

    if (product.mainImage) {
      const mainImageDto = new MainImageDto();
      mainImageDto.url = product.mainImage.url ?? '';
      dto.mainImage = mainImageDto;
    } else {
      dto.mainImage = null;
    }

    return dto;
  }
}
