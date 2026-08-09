import { IsEnum, IsOptional, IsString } from "class-validator";
import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";

export enum MentionFrequencyGranularity {
  day = "day",
  week = "week",
  month = "month",
}

export class MentionFrequencyQueryDto {
  @IsOptional()
  @IsEnum(MentionFrequencyGranularity)
  granularity?: MentionFrequencyGranularity = MentionFrequencyGranularity.month;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class MentionFrequencyDataPointDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  date: string;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  count: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  positive: number;
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  negative: number;
}

export class MentionFrequencyResultDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  dataPoints: MentionFrequencyDataPointDto[];
}
