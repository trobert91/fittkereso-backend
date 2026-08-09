import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { nameOf } from "@ebike-backend/utils";
import { BasePostgresRepository } from "./base-postgres-repository";
import { BrandAlias, BrandAliasSource } from "../models/brand-alias.entity";
import { WithSimilarity } from "../models/with-similarity";

@Injectable()
export class BrandAliasRepository extends BasePostgresRepository<BrandAlias> {
  constructor(
    @InjectRepository(BrandAlias, "postgres")
    repository: Repository<BrandAlias>,
  ) {
    super(repository, BrandAlias);
  }

  async findByAlias(alias: string): Promise<BrandAlias | null> {
    return this.repo.findOne({
      where: { alias: alias.toLowerCase().trim() },
      relations: { brand: true },
    });
  }

  async findWithSimilarity(
    alias: string,
    minSimilarity: number,
    limit: number,
  ): Promise<WithSimilarity<BrandAlias>[]> {
    const aliasColumn = `ba.${nameOf<BrandAlias>("alias")}`;
    const { entities, raw } = await this.repo
      .createQueryBuilder("ba")
      .leftJoinAndSelect(`ba.${nameOf<BrandAlias>("brand")}`, "brand")
      .addSelect(`similarity(${aliasColumn}, :alias)`, "similarity")
      .where(`similarity(${aliasColumn}, :alias) >= :minSimilarity`, {
        alias,
        minSimilarity,
      })
      .orderBy(`similarity(${aliasColumn}, :alias)`, "DESC")
      .limit(limit)
      .getRawAndEntities();

    return entities.map((entity, idx) => ({
      entity,
      similarity: parseFloat(raw[idx].similarity),
    }));
  }

  async upsertAlias(
    alias: string,
    brandId: string,
    source: BrandAliasSource,
  ): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(BrandAlias)
      .values({
        alias: alias.toLowerCase().trim(),
        brand: { id: brandId },
        source,
      })
      .orIgnore()
      .execute();
  }
}
