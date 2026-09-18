import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { User, UserRepository } from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from '@fittkereso-backend/supabase';
import { every, isUndefined } from 'lodash';
import { UserUpdateDto } from '../models';
import { normalizeEmail } from '../utils';

@Injectable()
export class UserUpdateService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly supabaseAuthAdmin: SupabaseAuthAdminService,
  ) {}

  async update(id: string, dto: UserUpdateDto): Promise<User> {
    // Checked field by field rather than with isEmpty: the validation pipe
    // hands us a class instance, which can carry declared-but-undefined keys.
    const patchedValues = [
      dto.name,
      dto.email,
      dto.role,
      dto.passwordChangeRequired,
    ];
    if (every(patchedValues, isUndefined)) {
      throw new BadRequestException('No changes supplied');
    }

    const user = await this.userRepository.findByIdOrFail(id);

    if (!isUndefined(dto.email)) {
      await this.applyEmailChange(user, dto.email);
    }
    if (!isUndefined(dto.name)) {
      user.name = dto.name;
    }
    if (!isUndefined(dto.role)) {
      user.role = dto.role;
    }
    if (!isUndefined(dto.passwordChangeRequired)) {
      user.passwordChangeRequired = dto.passwordChangeRequired;
    }

    // Keep the advisory app_metadata mirror in step so the admin frontend,
    // which reads these off the JWT, agrees with us by the next token refresh.
    await this.supabaseAuthAdmin.updateAccountMetadata(user.authUserId, {
      role: dto.role,
      passwordChangeRequired: dto.passwordChangeRequired,
    });

    return this.userRepository.save(user);
  }

  private async applyEmailChange(user: User, email: string): Promise<void> {
    const nextEmail = normalizeEmail(email);

    // A form that resends the address unchanged should never reach Supabase.
    if (nextEmail === user.email) {
      return;
    }

    // Checked up front because GoTrue answers an admin update onto a taken
    // address with a bare 500 and no error code, which would surface as a
    // confusing 502 rather than the conflict it actually is.
    const clash = await this.userRepository.findByEmail(nextEmail);
    if (clash) {
      throw new ConflictException('An account with this email already exists');
    }

    await this.supabaseAuthAdmin.updateAccountEmail(user.authUserId, nextEmail);
    user.email = nextEmail;
  }
}
