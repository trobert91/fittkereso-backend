import { Injectable } from '@nestjs/common';
import { SupabaseConfigService } from '@fittkereso-backend/config';
import { UserRole } from '@fittkereso-backend/database';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface SupabaseAppMetadata {
  /** Advisory mirror of app_user.role - the backend never trusts this. */
  role?: UserRole;
  /** Advisory mirror of app_user.passwordChangeRequired. */
  password_change_required?: boolean;
}

export interface DecodedToken {
  sub: string; // Supabase user ID
  email: string; // User email
  /**
   * Supabase puts app_metadata in the access token by default, which is what
   * lets the admin frontend gate routes without an extra round trip. It is a
   * mirror, not the source of truth: role is resolved from the local user row.
   */
  app_metadata?: SupabaseAppMetadata;
  /** @deprecated Legacy custom claim; role now comes from the local user row. */
  user_role?: UserRole;
}

@Injectable()
export class SupabaseJwtService {
  private readonly jwtIssuer: string;
  private readonly jwkSet;

  constructor(supabaseConfig: SupabaseConfigService) {
    this.jwtIssuer = supabaseConfig.url + '/auth/v1';
    this.jwkSet = createRemoteJWKSet(
      new URL(this.jwtIssuer + '/.well-known/jwks.json'),
    );
  }

  /**
   * Verifies and decodes a Supabase asymmetric JWT token
   * https://supabase.com/blog/jwt-signing-keys
   */
  async verifyToken(token: string): Promise<DecodedToken> {
    const result = await jwtVerify(token, this.jwkSet, {
      issuer: this.jwtIssuer,
    });

    return result.payload as any as DecodedToken;
  }
}
