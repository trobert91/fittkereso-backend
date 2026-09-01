import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductModel } from '../models/product-model.entity';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty } from 'lodash';
import { ProductCategory } from '../models';

@Injectable()
export class ProductModelRepository extends BasePostgresRepository<ProductModel> {
  constructor(
    @InjectRepository(ProductModel, 'postgres')
    repository: Repository<ProductModel>,
  ) {
    super(repository, ProductModel);
  }

  public async findByIdForPipeline(id: string): Promise<ProductModel | null> {
    return this.repo.findOne({
      where: { id },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('sources'),
      ],
    });
  }

  /**
   * Which of these (brand, category) corners the catalog actually has products
   * in, as a set of `${brandId}:${categoryId}` keys.
   *
   * Answers one question for the review queue: when recall found nothing for a
   * listing that named a brand and a model, is that *surprising*? It is only
   * surprising if we already hold products of that brand in that category —
   * which makes an empty recall a brand-alias gap or an over-tight filter rather
   * than an ordinary new product. Without this check the
   * `no_candidates_but_named` trigger fires on every new product in a growing
   * catalog and tells a reviewer nothing.
   *
   * One query for a whole sweep batch, not one per row: this runs nightly over
   * thousands of rows, and a per-row existence check is the shape that would
   * make the sweep unusable.
   *
   * Raw rather than the query builder because the natural expression is a row
   * constructor — `(brandId, categoryId) IN ((…),(…))` — and TypeORM's
   * `:...param` expansion turns an array of pairs into array *parameters*, not
   * row literals, which Postgres rejects. A `VALUES` join says exactly what is
   * meant, and lets the planner use the `(productCategory, enabled)` index.
   */
  public async findPopulatedBrandCategoryPairs(
    pairs: ReadonlyArray<{ brandId: string; categoryId: string }>,
  ): Promise<Set<string>> {
    if (pairs.length === 0) return new Set();

    const params: string[] = [];
    const values = pairs
      .map((pair) => {
        const base = params.length;
        params.push(pair.brandId, pair.categoryId);
        return `($${base + 1}::uuid, $${base + 2}::uuid)`;
      })
      .join(', ');

    const brandColumn = `${nameOf<ProductModel>('brand')}Id`;
    const categoryColumn = `${nameOf<ProductModel>('productCategory')}Id`;

    const rows = await this.repo.query(
      `SELECT DISTINCT product."${brandColumn}" AS "brandId",
                       product."${categoryColumn}" AS "categoryId"
       FROM "${this.repo.metadata.tableName}" AS product
       JOIN (VALUES ${values}) AS pair(brand_id, category_id)
         ON product."${brandColumn}" = pair.brand_id
        AND product."${categoryColumn}" = pair.category_id`,
      params,
    );

    return new Set(
      (rows as { brandId: string; categoryId: string }[]).map((row) =>
        brandCategoryKey(row.brandId, row.categoryId),
      ),
    );
  }

  /**
   * The products a reviewer is being asked to judge, loaded **live**.
   *
   * The persisted row deliberately keeps no copy of a candidate's specs, aliases
   * or category — only what the matcher derived, which cannot be recomputed. The
   * entity data can be, and live is the only correct version to review against:
   * acting on a row acts on the product as it is now, so a months-old spec copy
   * could have a merge approved on grounds that no longer hold.
   *
   * One query for every candidate on the row rather than one each, because a
   * resolution can carry dozens.
   */
  public async findForReview(ids: string[]): Promise<ProductModel[]> {
    if (isEmpty(ids)) return [];

    return this.repo.find({
      where: ids.map((id) => ({ id })),
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('aliases'),
      ],
    });
  }

  /**
   * Catalog products sharing a brand and category, for the one extra lookup a
   * `no_candidates_but_named` row earns.
   *
   * That trigger means recall found nothing where the catalog *does* hold this
   * brand in this category — so the answer is very likely sitting right here,
   * behind a brand-alias gap or an over-tight filter. Without this the AI is
   * asked to judge a row with no candidates at all, which it cannot do.
   */
  public async findByBrandAndCategory(
    brandId: string,
    categoryId: string,
    limit: number,
  ): Promise<ProductModel[]> {
    return this.repo.find({
      where: { brand: { id: brandId }, productCategory: { id: categoryId } },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('aliases'),
      ],
      take: limit,
    });
  }

  public async findByCategoryId(categoryId: string): Promise<ProductModel[]> {
    return this.repo
      .createQueryBuilder('productModel')
      .leftJoinAndSelect(
        `productModel.${nameOf<ProductModel>('productCategory')}`,
        'productCategory',
      )
      .where(`productCategory.${nameOf<ProductCategory>('id')} = :categoryId`, {
        categoryId,
      })
      .getMany();
  }
}

/** The lookup key for `findPopulatedBrandCategoryPairs`. Exported so callers
 *  build it the same way rather than each inventing a separator. */
export function brandCategoryKey(
  brandId: string,
  categoryId: string,
): string {
  return `${brandId}:${categoryId}`;
}
