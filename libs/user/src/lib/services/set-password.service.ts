import { Injectable } from '@nestjs/common';
import { UserRepository } from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from '@fittkereso-backend/supabase';
import { LoginService } from '@fittkereso-backend/auth';
import { CustomLogger } from '@fittkereso-backend/logger';

export interface SetPasswordResult {
  accessToken?: string;
  refreshToken?: string;
}

@Injectable()
export class SetPasswordService {
  private readonly logger = new CustomLogger(SetPasswordService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly supabaseAuthAdmin: SupabaseAuthAdminService,
    private readonly loginService: LoginService,
  ) {}

  /**
   * Replaces the caller's password and lifts the temporary-password hold.
   *
   * All four steps matter. Control-plane gets the flag cleared by a database
   * trigger on auth.users; our Supabase is a separate database, so nothing
   * clears it except the code paths we write - and a fresh session has to be
   * issued too, or the browser keeps presenting a JWT that still carries the
   * claim and the middleware bounces it straight back here until it expires.
   */
  async setPassword(params: {
    userId: string;
    password: string;
  }): Promise<SetPasswordResult> {
    const user = await this.userRepository.findByIdOrFail(params.userId);

    await this.supabaseAuthAdmin.updateAccountPassword(
      user.authUserId,
      params.password,
    );

    user.passwordChangeRequired = false;
    await this.userRepository.save(user);

    await this.supabaseAuthAdmin.updateAccountMetadata(user.authUserId, {
      passwordChangeRequired: false,
    });

    return this.issueFreshSession(user.email, params.password);
  }

  /**
   * Signs in again rather than refreshing.
   *
   * A password change revokes the account's existing refresh tokens, so
   * refreshing here fails by definition - we would be presenting the very
   * token the change just invalidated. Signing in with the password we were
   * handed is the only way to mint a session that reflects the new state.
   *
   * A failure here is not fatal: the password really was changed, so the
   * caller gets a success and simply signs in again.
   */
  private async issueFreshSession(
    email: string,
    password: string,
  ): Promise<SetPasswordResult> {
    try {
      const session = await this.loginService.login(email, password);

      return {
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
      };
    } catch (error) {
      this.logger.error(
        'Password was changed but a new session could not be issued; ' +
          'the caller will have to sign in again.',
        error,
        { email },
      );

      return {};
    }
  }
}
