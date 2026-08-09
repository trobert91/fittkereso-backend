import { IsDefined, IsString } from 'class-validator';

export class ThreadCreateDto {
  @IsDefined()
  @IsString()
  externalId: string;
}
