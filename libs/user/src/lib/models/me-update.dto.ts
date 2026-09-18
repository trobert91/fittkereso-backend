import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Self-service profile edits, as opposed to a superadmin editing someone else. */
export class MeUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  /** Required when changing the email address, to prove the session is really theirs. */
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
