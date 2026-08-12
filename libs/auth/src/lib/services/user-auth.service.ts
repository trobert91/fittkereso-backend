import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedUser } from '../models';
import { SupabaseJwtService } from '@fittkereso-backend/supabase';
import { UserRole } from '@fittkereso-backend/database';

@Injectable()
export class UserAuthService {
  constructor(private readonly supabaseJwtService: SupabaseJwtService) {}
  public async getUser(accessToken: string): Promise<AuthenticatedUser> {
    try {
      // Just decode, don't verify — Supabase already issued this token
      const decoded = await this.supabaseJwtService.verifyToken(accessToken);

      if (!decoded || !decoded.sub || !decoded.email) {
        throw new UnauthorizedException('Invalid or malformed token');
      }

      const user = new AuthenticatedUser();
      user.id = decoded.sub;
      user.email = decoded.email;
      user.role = decoded.user_role ?? UserRole.user;

      return user;
    } catch (error) {
      throw new UnauthorizedException('Invalid access token');
    }
  }
}
