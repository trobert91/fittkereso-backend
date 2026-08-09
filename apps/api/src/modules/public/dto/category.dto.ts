import { Expose, Transform, Type } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import type {
  FilterType,
  SpecDefinitionJsonSchema,
  SpecDefinitionUiSchema,
} from "@ebike-backend/database";

export class CategoryListDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] }) id: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  slug: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  name: string;
}

export class CategoryDetailDto extends CategoryListDto {
  @Expose({ groups: [SerializeGroup.details] }) categoryDescription?: string;
  @Expose({ groups: [SerializeGroup.details] })
  @Transform(({ value }) => value ?? undefined)
  jsonSchema?: SpecDefinitionJsonSchema;
  @Expose({ groups: [SerializeGroup.details] })
  @Transform(({ value }) => value ?? undefined)
  uiSchema?: SpecDefinitionUiSchema;
  @Expose({ groups: [SerializeGroup.details] })
  @Transform(({ value }) => value ?? undefined)
  useCases?: string[];
}

export class FilterOptionDto {
  @Expose({ groups: [SerializeGroup.details] }) value: string;
  @Expose({ groups: [SerializeGroup.details] }) label: string;
  @Expose({ groups: [SerializeGroup.details] }) count: number;
}

export class NumericRangeDto {
  @Expose({ groups: [SerializeGroup.details] }) min: number;
  @Expose({ groups: [SerializeGroup.details] }) max: number;
}

export class FilterFieldDto {
  @Expose({ groups: [SerializeGroup.details] }) key: string;
  @Expose({ groups: [SerializeGroup.details] }) label: string;
  @Expose({ groups: [SerializeGroup.details] }) type: FilterType;
  @Expose({ groups: [SerializeGroup.details] }) unit?: string;
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => FilterOptionDto)
  options?: FilterOptionDto[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => NumericRangeDto)
  range?: NumericRangeDto;
  @Expose({ groups: [SerializeGroup.details] }) trueCount?: number;
  @Expose({ groups: [SerializeGroup.details] }) totalCount?: number;
  @Expose({ groups: [SerializeGroup.details] }) openByDefault?: boolean;
}

export class FilterConfigDto {
  @Expose({ groups: [SerializeGroup.details] })
  jsonSchema?: SpecDefinitionJsonSchema;
  @Expose({ groups: [SerializeGroup.details] })
  uiSchema?: SpecDefinitionUiSchema;
  @Expose({ groups: [SerializeGroup.details] }) primarySpecs: string[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => FilterFieldDto)
  aggregations?: FilterFieldDto[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => FilterOptionDto)
  brands?: FilterOptionDto[];
  @Expose({ groups: [SerializeGroup.details] })
  @Type(() => NumericRangeDto)
  scoreRange?: NumericRangeDto;
  @Expose({ groups: [SerializeGroup.details] }) totalProducts?: number;
}
