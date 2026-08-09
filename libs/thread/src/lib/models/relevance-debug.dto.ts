import { IsBoolean, IsOptional } from 'class-validator';
import { ThreadCreateDto } from './thread-create.dto';

export class RelevanceDebugDto extends ThreadCreateDto {
  /**
   * When true, also run Stage 2 (the LLM selection pipeline) against the
   * in-memory thread. Defaults to false — only Stage 1 (cheap term scorer)
   * runs unless explicitly requested, since Stage 2 costs a real LLM call.
   */
  @IsOptional()
  @IsBoolean()
  llmCalculation?: boolean;
}
