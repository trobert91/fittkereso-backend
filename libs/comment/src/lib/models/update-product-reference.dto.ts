import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import {
  ContentQuality,
  ExperienceType,
  Intent,
  Sentiment,
} from "@ebike-backend/database";
import { Type } from "class-transformer";

const CONTENT_QUALITY_VALUES: ContentQuality[] = ["high", "medium", "low"];

export class StructuredSpecDto {
  @IsString()
  @IsDefined()
  name: string;

  @IsString()
  @IsDefined()
  value: string;
}

export class EvidenceDto {
  @IsString()
  @IsDefined()
  @IsNotEmpty()
  label: string;

  @IsOptional()
  @IsEnum(Sentiment)
  sentiment?: Sentiment;
}

export class QuoteDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsDefined()
  text: string;

  @IsEnum(Sentiment)
  @IsDefined()
  sentiment: Sentiment;

  @IsOptional()
  @IsBoolean()
  speculative?: boolean;

  @IsOptional()
  @IsIn(CONTENT_QUALITY_VALUES)
  quality?: ContentQuality;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvidenceDto)
  features?: EvidenceDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvidenceDto)
  useCases?: EvidenceDto[];

  /** Closed-list issue evidence with required negative severity sentiment. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvidenceDto)
  issues?: EvidenceDto[];
}

export class UpdateResolvedModelDto {
  @IsString()
  @IsDefined()
  id: string;
}

/**
 * Single candidate entry in `UpdateProductReferenceDto.candidates`. The admin
 * supplies the model id, the confidence score (0–100), and which entry is
 * primary. Weights are softmax-derived server-side so the admin never has to
 * normalise them by hand.
 */
export class UpdateProductReferenceCandidateDto {
  @IsString()
  @IsDefined()
  modelId: string;

  @IsOptional()
  @IsNumber()
  confidence?: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateProductReferenceDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => UpdateResolvedModelDto)
  resolvedModel?: UpdateResolvedModelDto;

  /**
   * Full candidate set for this reference. When present, replaces the
   * candidate list on the server (delete-then-insert via
   * `ResolutionResultApplierService.copyCandidateSet`). Weights are softmax-
   * derived from the supplied confidences.
   *
   * Mutually exclusive with `resolvedModel` — if both are sent, `candidates`
   * wins because it's the more expressive update. If neither is sent, the
   * existing candidate set is left untouched.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateProductReferenceCandidateDto)
  candidates?: UpdateProductReferenceCandidateDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteDto)
  quotes?: QuoteDto[];

  @IsOptional()
  @IsEnum(Sentiment)
  sentiment?: Sentiment;

  @IsOptional()
  @IsNumber()
  relevance?: number;

  @IsOptional()
  @IsEnum(Intent, { each: true })
  intents?: Intent[];

  @IsOptional()
  @IsEnum(ExperienceType)
  experience?: ExperienceType;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StructuredSpecDto)
  specs?: StructuredSpecDto[] | null;

  /** Reference-level feature evidence (cross-quote LLM emits — admin can
   *  add/remove or replace via this field). Each entry must carry a sentiment
   *  for label-consolidation to weight it correctly. Issue evidence is
   *  quote-level only and has no ref-level counterpart. Pass an empty array
   *  to clear, omit to leave untouched. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvidenceDto)
  features?: EvidenceDto[] | null;

  /** Reference-level use-case evidence (e.g. "dual use"). Pass an empty array
   *  to clear, omit to leave untouched. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvidenceDto)
  useCases?: EvidenceDto[] | null;
}
