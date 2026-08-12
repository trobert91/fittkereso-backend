import { Injectable } from '@nestjs/common';
import { SupabaseConfigService } from '@fittkereso-backend/config';
import { UserRole } from '@fittkereso-backend/database';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface DecodedToken {
  sub: string; // Supabase user ID
  email: string; // User email
  user_role?: UserRole; // Custom metadata (optional)
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
