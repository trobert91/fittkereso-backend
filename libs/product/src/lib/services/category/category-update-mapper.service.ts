import { Injectable } from "@nestjs/common";
import {
  ProductCategory,
  ProductCategoryEmbedding,
} from "@ebike-backend/database";
import { isUndefined } from "lodash";
import { AiEmbeddingService } from "@ebike-backend/ai";
import { CategoryUpdateDto } from "../../models";

@Injectable()
export class CategoryUpdateMapperService {
  constructor(private readonly aiEmbedding: AiEmbeddingService) {}

  public async mapDtoToEntity(
    dto: CategoryUpdateDto,
    entity: ProductCategory,
  ): Promise<ProductCategory> {
    let regenerateEmbeddingNeeded = false;

    if (!isUndefined(dto.name) && entity.name !== dto.name) {
      regenerateEmbeddingNeeded = true;
      entity.name = dto.name;
    }

    if (!isUndefined(dto.enabled)) {
      entity.enabled = dto.enabled;
    }

    if (!isUndefined(dto.extractionEnabled)) {
      entity.extractionEnabled = dto.extractionEnabled;
    }

    if (!isUndefined(dto.searchEnabled)) {
      entity.searchEnabled = dto.searchEnabled;
    }

    if (!isUndefined(dto.searchPriority)) {
      entity.searchPriority = dto.searchPriority;
    }

    if (!isUndefined(dto.aliases)) {
      entity.aliases = dto.aliases;
    }

    if (!isUndefined(dto.autoDeduplicationEnabled)) {
      entity.autoDeduplicationEnabled = dto.autoDeduplicationEnabled;
    }

    if (regenerateEmbeddingNeeded) {
      await this.regenerateEmbedding(entity);
    }

    return entity;
  }

  private async regenerateEmbedding(entity: ProductCategory) {
    entity.embedding = entity.embedding ?? new ProductCategoryEmbedding();
    const generatedEmbedding = await this.aiEmbedding.createCategoryEmbedding(
      entity.name,
    );
    entity.embedding.embedding = generatedEmbedding;
  }
}
