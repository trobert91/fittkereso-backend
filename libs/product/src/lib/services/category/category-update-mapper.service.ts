import { Injectable } from '@nestjs/common';
import { ProductCategory } from '@fittkereso-backend/database';
import { isUndefined } from 'lodash';
import { CategoryUpdateDto } from '../../models';

@Injectable()
export class CategoryUpdateMapperService {
  public mapDtoToEntity(
    dto: CategoryUpdateDto,
    entity: ProductCategory,
  ): ProductCategory {
    if (!isUndefined(dto.name) && entity.name !== dto.name) {
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

    return entity;
  }
}
