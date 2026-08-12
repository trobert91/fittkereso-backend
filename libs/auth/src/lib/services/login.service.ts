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
}
