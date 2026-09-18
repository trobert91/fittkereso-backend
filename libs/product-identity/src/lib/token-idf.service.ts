import { Injectable } from '@nestjs/common';
import { ProductModel, ProductModelRepository } from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { TOKEN_IDF_TTL_MS } from './product-identity.constants';
import { FLAT_IDF, TokenIdf } from './name-similarity';

interface CachedIdf {
  idf: TokenIdf;
  expiresAt: number;
}

interface TokenRow {
  token: string;
  df: number | string;
  total: number | string;
}

/**
 * How often each name-key token occurs among the products of one brand and
 * category — the scope recall already searches — turned into the IDF the
 * alignment similarity weighs tokens by.
 *
 * Without it every token counts the same, and the brand's own line name
 * (`macina`, in all 58 KTM e-bikes) would carry as much identity as the trim
 * that actually separates two bikes.
 *
 * One query per scope, cached for TOKEN_IDF_TTL_MS: a catalog run matches
 * hundreds of listings against the same brand, and a handful of new products
 * barely moves a frequency computed over all of them.
 */
@Injectable()
export class TokenIdfService {
  private readonly cache = new Map<string, CachedIdf>();

  constructor(private readonly productRepo: ProductModelRepository) {}

  public async forScope(
    brandId: string,
    categoryId: string,
  ): Promise<TokenIdf> {
    const key = `${brandId}:${categoryId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.idf;

    const idf = await this.build(brandId, categoryId);
    this.cache.set(key, { idf, expiresAt: Date.now() + TOKEN_IDF_TTL_MS });
    return idf;
  }

  /** Drops every cached scope. Only the tests need this. */
  public clear(): void {
    this.cache.clear();
  }

  private async build(
    brandId: string,
    categoryId: string,
  ): Promise<TokenIdf> {
    const products = `"${this.productRepo.repo.metadata.tableName}"`;
    const normalizedName = `"${nameOf<ProductModel>('normalizedName')}"`;
    const brand = `"${nameOf<ProductModel>('brand')}Id"`;
    const category = `"${nameOf<ProductModel>('productCategory')}Id"`;

    const rows: TokenRow[] = await this.productRepo.repo.query(
      `WITH tokens AS (
         SELECT DISTINCT pm.id,
                unnest(string_to_array(pm.${normalizedName}, ' ')) AS token
         FROM ${products} AS pm
         WHERE pm.${brand} = $1 AND pm.${category} = $2
           AND pm.${normalizedName} IS NOT NULL AND pm.${normalizedName} <> ''
       )
       SELECT token,
              COUNT(*)::int AS df,
              (SELECT COUNT(DISTINCT id) FROM tokens)::int AS total
       FROM tokens
       WHERE token <> ''
       GROUP BY token`,
      [brandId, categoryId],
    );

    const total = Number(rows[0]?.total ?? 0);
    // One product (or none) gives every token the same frequency, so IDF
    // carries no information — fall back rather than divide by log(1) = 0.
    if (total <= 1) return FLAT_IDF;

    const frequencies = new Map<string, number>(
      rows.map((row) => [row.token, Number(row.df)]),
    );
    const scale = Math.log(total);

    return (token: string) => {
      // A token no stored product carries is as discriminating as it gets.
      const df = frequencies.get(token) ?? 1;
      return Math.log(total / df) / scale;
    };
  }
}
