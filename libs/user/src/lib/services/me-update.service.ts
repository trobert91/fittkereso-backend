import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { User, UserRepository } from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from '@fittkereso-backend/supabase';
import { LoginService } from '@fittkereso-backend/auth';
import { every, isUndefined } from 'lodash';
import { MeUpdateDto } from '../models';
import { normalizeEmail } from '../utils';

@Injectable()
export class MeUpdateService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly supabaseAuthAdmin: SupabaseAuthAdminService,
    private readonly loginService: LoginService,
  ) {}

  /** Self-service profile edit. Role is deliberately not editable here. */
  async update(userId: string, dto: MeUpdateDto): Promise<User> {
    if (every([dto.name, dto.email], isUndefined)) {
      throw new BadRequestException('No changes supplied');
    }

    const user = await this.userRepository.findByIdOrFail(userId);

    if (!isUndefined(dto.email)) {
      await this.applyEmailChange(user, dto.email, dto.currentPassword);
    }
    if (!isUndefined(dto.name)) {
      user.name = dto.name;
    }

    return this.userRepository.save(user);
  }

  private async applyEmailChange(
    user: User,
    email: string,
    currentPassword?: string,
  ): Promise<void> {
    const nextEmail = normalizeEmail(email);
    if (nextEmail === user.email) {
      return;
    }

    if (!currentPassword) {
      throw new BadRequestException(
        'Your current password is required to change your email address',
      );
    }
    await this.verifyCurrentPassword(user.email, currentPassword);

    const clash = await this.userRepository.findByEmail(nextEmail);
    if (clash) {
      throw new ConflictException('An account with this email already exists');
    }

    await this.supabaseAuthAdmin.updateAccountEmail(user.authUserId, nextEmail);
    user.email = nextEmail;
  }

  /**
   * Signing in is the only way GoTrue will answer "is this the current
   * password". A valid session comes back as a side effect and is simply
   * discarded - the caller keeps the session they already had.
   */
  private async verifyCurrentPassword(
    email: string,
    password: string,
  ): Promise<void> {
    try {
      await this.loginService.login(email, password);
    } catch {
      throw new UnauthorizedException('Current password is incorrect');
    }
  }
}
