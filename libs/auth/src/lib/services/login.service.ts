import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseClientService } from '@fittkereso-backend/supabase';

@Injectable()
export class LoginService {
  constructor(private readonly supabase: SupabaseClientService) {}

  async login(email: string, password: string) {
    const supabase = this.supabase.getClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    return {
      access_token: data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      user: data.user,
    };
  }

  async refresh(refreshToken: string) {
    const supabase = this.supabase.getClient();

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    return {
      access_token: data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      user: data.user,
    };
  }

  /**
   * Exchanges a recovery token hash from a password-reset link for a session.
   *
   * Deliberately server-side: GoTrue's own verify endpoint hands the session
   * back in a URL fragment, which the server can never read. Doing it here
   * means the reset lands in the same httpOnly cookies as a normal sign-in.
   */
  async verifyRecoveryToken(tokenHash: string) {
    const supabase = this.supabase.getClient();

    const { data, error } = await supabase.auth.verifyOtp({
      type: 'recovery',
      token_hash: tokenHash,
    });

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    return {
      access_token: data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      user: data.user,
    };
  }
}
