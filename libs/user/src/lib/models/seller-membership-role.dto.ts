import { IsEnum } from 'class-validator';
import { SellerMemberRole } from '@fittkereso-backend/database';

/** The role an account is given at one seller. */
export class SellerMembershipRoleDto {
  @IsEnum(SellerMemberRole)
  role: SellerMemberRole;
}
