import { Injectable } from '@nestjs/common';
import {
  BrandAliasRepository,
  BrandRepository,
  WithSimilarity,
  Brand,
} from '@fittkereso-backend/database';
import { normalize } from '@fittkereso-backend/utils';
import { chain, isEmpty } from 'lodash';

@Injectable()
export class BrandResolutionService {
  constructor(
    private readonly brandRepo: BrandRepository,
    private readonly brandAliasRepo: BrandAliasRepository,
  ) {}

  /** `title`: the listing's title, searched by its first words when the brand string resolves nothing. */
  public async resolve(
    brandName: string | undefined,
    title: string | undefined,
  ): Promise<WithSimilarity<Brand> | undefined> {
    let brand = await this.resolveFromBrandName(brandName);
    if (!brand?.entity) {
      brand = await this.resolveFromTitle(title);
    }

    return brand;
  }

  private async resolveFromBrandName(
    brandName: string | undefined,
  ): Promise<WithSimilarity<Brand> | undefined> {
    if (!brandName) return undefined;

    const normalized = normalize(brandName);

    // Step 1: Exact alias match — O(1) via unique index
    const exactAlias = await this.brandAliasRepo.findByAlias(normalized);
    if (exactAlias) {
      return { entity: exactAlias.brand, similarity: 1.0 };
    }

    // Step 2: Trigram on Brand.name
    const brandsByName = await this.brandRepo.findWithSimilarity(
      normalized,
      0.8,
      5,
    );
    const topByName = chain(brandsByName)
      .orderBy((candidate) => candidate.similarity, 'desc')
      .first()
      .value();
    if (topByName) return topByName;

    // Step 3: Trigram on BrandAlias.alias
    const aliasByTrigram = await this.brandAliasRepo.findWithSimilarity(
      normalized,
      0.8,
      5,
    );
    const topAlias = chain(aliasByTrigram)
      .orderBy((candidate) => candidate.similarity, 'desc')
      .first()
      .value();
    if (topAlias) {
      return { entity: topAlias.entity.brand, similarity: topAlias.similarity };
    }

    return undefined;
  }

  private async resolveFromTitle(
    title: string | undefined,
  ): Promise<WithSimilarity<Brand> | undefined> {
    if (!title) return undefined;

    // search by first word, then by first two words
    let brands = await this.searchSimilarBrandByName(title.split(' ')[0]);
    if (isEmpty(brands)) {
      brands = await this.searchSimilarBrandByName(
        title.split(' ').slice(0, 2).join(' '),
      );
    }

    return chain(brands)
      .orderBy((candidate) => candidate.similarity, 'desc')
      .first()
      .value();
  }

  private async searchSimilarBrandByName(
    input: string,
  ): Promise<WithSimilarity<Brand>[]> {
    const normalized = normalize(input);
    return this.brandRepo.findWithSimilarity(normalized, 0.8, 5);
  }
}
