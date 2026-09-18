import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseJwtService } from '@fittkereso-backend/supabase';
import { UserRepository } from '@fittkereso-backend/database';
import { AuthenticatedUser } from '../models';

@Injectable()
export class UserAuthService {
  constructor(
    private readonly supabaseJwtService: SupabaseJwtService,
    private readonly userRepository: UserRepository,
  ) {}

  /**
   * Resolves a verified Supabase token to the local account.
   *
   * The token establishes *who* the caller is; the local app_user row decides
   * what they may do. There is deliberately no fallback to the token's own
   * role claim and no default role: the claim is a mirror we write for the
   * frontend's benefit and cannot be audited from here, so it must not be
   * able to grant anything.
   *
   * A token with no matching row is rejected rather than auto-provisioned.
   * Even the lowest role is read access to the whole admin surface, so if
   * sign-ups are open on the Supabase project, auto-provisioning would hand
   * that to anyone who registers. Accounts are created by a superadmin or by
   * the seed script, never by showing up.
   */
  public async getUser(accessToken: string): Promise<AuthenticatedUser> {
    const decoded = await this.supabaseJwtService.verifyToken(accessToken);

    if (!decoded?.sub) {
      throw new UnauthorizedException('Invalid access token');
    }

    const user = await this.userRepository.findByAuthUserId(decoded.sub);

    if (!user) {
      // Same message as a malformed token on purpose, so this cannot be used
      // to discover which addresses have an admin account.
      throw new UnauthorizedException('Invalid access token');
    }

    const authenticatedUser = new AuthenticatedUser();
    authenticatedUser.id = user.id;
    authenticatedUser.authUserId = user.authUserId;
    authenticatedUser.email = user.email;
    authenticatedUser.name = user.name;
    authenticatedUser.role = user.role;
    authenticatedUser.passwordChangeRequired = user.passwordChangeRequired;

    return authenticatedUser;
  }
}
