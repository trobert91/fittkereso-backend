import { IsEmail, IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { UserRole } from '@fittkereso-backend/database';

/** Minimum GoTrue will accept by default; a stricter project policy is enforced by Supabase itself. */
export const MIN_TEMPORARY_PASSWORD_LENGTH = 6;

export class UserCreateDto {
  @IsEmail()
  email: string;

  /**
   * The temporary password the superadmin hands to the new account holder.
   * The account is created with passwordChangeRequired set, so this password
   * only survives until their first sign-in.
   */
  @IsString()
  @MinLength(MIN_TEMPORARY_PASSWORD_LENGTH)
  password: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEnum(UserRole)
  role: UserRole;
}
