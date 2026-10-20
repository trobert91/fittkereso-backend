import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { SellerMemberRole, UserRole } from '@fittkereso-backend/database';

/** Minimum GoTrue will accept by default; a stricter project policy is enforced by Supabase itself. */
export const MIN_TEMPORARY_PASSWORD_LENGTH = 6;

export class UserCreateDto {
  @IsEmail()
  email: string;

  /**
   * The temporary password the admin hands to the new account holder.
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

  /**
   * Optionally makes the new account a member of one seller straight away -
   * the usual way a partner account is created. Both or neither: each
   * ValidateIf makes its field required as soon as the other is sent.
   */
  @ValidateIf((dto: UserCreateDto) => dto.sellerId !== undefined || dto.sellerRole !== undefined)
  @IsUUID()
  sellerId?: string;

  @ValidateIf((dto: UserCreateDto) => dto.sellerId !== undefined || dto.sellerRole !== undefined)
  @IsEnum(SellerMemberRole)
  sellerRole?: SellerMemberRole;
}
