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

    if (!isUndefined(dto.aliases)) {
      entity.aliases = dto.aliases;
    }

    return entity;
  }
}
