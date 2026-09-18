import { Injectable } from '@nestjs/common';
import { UserRepository } from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from '@fittkereso-backend/supabase';
import { PasswordResetEmailService } from '@fittkereso-backend/email';
import { AppSettingsConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { normalizeEmail } from '../utils';

/**
 * Where the reset link lands. It must be a page of ours that finishes by
 * calling our own set-password endpoint: that endpoint is the only thing
 * that clears passwordChangeRequired, since our Supabase is a separate
 * database and no trigger can do it for us. A link that let the browser
 * change the password directly through Supabase would leave the flag set and
 * strand the account in a redirect loop.
 */
const CONFIRM_PATH = '/auth/confirm';
const NEXT_PATH = '/auth/set-password';

@Injectable()
export class PasswordResetService {
  private readonly logger = new CustomLogger(PasswordResetService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly supabaseAuthAdmin: SupabaseAuthAdminService,
    private readonly passwordResetEmail: PasswordResetEmailService,
    private readonly appSettings: AppSettingsConfigService,
  ) {}

  /**
   * Always resolves, whether or not the address belongs to an account.
   *
   * The caller answers 202 either way, so the endpoint cannot be used to
   * discover which addresses are registered.
   */
  async requestReset(email: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);

    try {
      const user = await this.userRepository.findByEmail(normalizedEmail);
      if (!user) {
        return;
      }

      const tokenHash =
        await this.supabaseAuthAdmin.generateRecoveryToken(normalizedEmail);
      if (!tokenHash) {
        return;
      }

      await this.passwordResetEmail.sendPasswordReset({
        email: normalizedEmail,
        resetUrl: this.buildResetUrl(tokenHash),
      });
    } catch (error) {
      // Swallowed on purpose: the response is identical either way, so a
      // failure here must not become a signal. It still needs to be visible
      // to us, hence the log.
      this.logger.error('Password reset request failed', error, {
        email: normalizedEmail,
      });
    }
  }

  private buildResetUrl(tokenHash: string): string {
    const url = new URL(CONFIRM_PATH, this.appSettings.adminUrl);
    url.searchParams.set('token_hash', tokenHash);
    url.searchParams.set('type', 'recovery');
    url.searchParams.set('next', NEXT_PATH);

    return url.toString();
  }
}
