import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { BasePostgresRepository } from "./base-postgres-repository";
import { ProductModelSource } from "../models/product-model-source.entity";
import { ProductModel } from "../models/product-model.entity";
import { isEmpty } from "lodash";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class ProductModelSourceRepository extends BasePostgresRepository<ProductModelSource> {
  constructor(
    @InjectRepository(ProductModelSource, "postgres")
    repository: Repository<ProductModelSource>,
  ) {
    super(repository, ProductModelSource);
  }

  async findByUrl(url: string): Promise<ProductModelSource | null> {
    return this.repo.findOne({
      where: { url },
      relations: [nameOf<ProductModelSource>("model")],
    });
  }

  async findExistingUrls(urls: string[]): Promise<Set<string>> {
    if (isEmpty(urls)) return new Set();

    const results = await this.repo
      .createQueryBuilder("source")
      .select(`source.${nameOf<ProductModelSource>("url")}`)
      .where(`source.${nameOf<ProductModelSource>("url")} IN (:...urls)`, {
        urls,
      })
      .getMany();

    return new Set(results.map((source) => source.url!));
  }

  async findAllByNormalizedName(
    normalizedSourceName: string,
    categoryId: string,
  ): Promise<ProductModelSource[]> {
    return this.repo
      .createQueryBuilder("source")
      .innerJoinAndSelect(
        `source.${nameOf<ProductModelSource>("model")}`,
        "model",
      )
      .innerJoinAndSelect(
        `model.${nameOf<ProductModel>("productCategory")}`,
        "category",
      )
      .leftJoinAndSelect(
        `model.${nameOf<ProductModel>("mainImage")}`,
        "mainImage",
      )
      .leftJoinAndSelect(`model.${nameOf<ProductModel>("images")}`, "images")
      .leftJoinAndSelect(
        `model.${nameOf<ProductModel>("embedding")}`,
        "embedding",
      )
      .leftJoinAndSelect(`model.${nameOf<ProductModel>("sources")}`, "sources")
      .where(
        `source.${nameOf<ProductModelSource>("normalizedSourceName")} = :normalizedSourceName`,
        { normalizedSourceName },
      )
      .andWhere("category.id = :categoryId", { categoryId })
      .getMany();
  }
}
