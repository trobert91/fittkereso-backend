import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { UserRole } from '@fittkereso-backend/database';

/**
 * Every field is optional: the admin UI sends only what changed.
 *
 * That matters because an account can have an empty name (nothing forces one
 * at creation time outside this API), and `name` is rejected when blank - so
 * resending the whole record would block a role change on such an account.
 */
export class UserUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  /** Lets a superadmin lift or re-impose the temporary-password hold. */
  @IsOptional()
  @IsBoolean()
  passwordChangeRequired?: boolean;
}
