import { Injectable } from '@nestjs/common';
import { UserRepository } from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';

@Injectable()
export class SignInRecordService {
  private readonly logger = new CustomLogger(SignInRecordService.name);

  constructor(private readonly userRepository: UserRepository) {}

  /**
   * Stamps the last sign-in time.
   *
   * Never allowed to fail a sign-in: this is bookkeeping, and refusing someone
   * a session because a timestamp would not write is a poor trade.
   */
  async recordSignIn(authUserId: string): Promise<void> {
    try {
      const user = await this.userRepository.findByAuthUserId(authUserId);
      if (!user) {
        return;
      }

      user.lastSignInAt = new Date();
      await this.userRepository.save(user);
    } catch (error) {
      this.logger.error('Failed to record sign-in time', error, { authUserId });
    }
  }
}
