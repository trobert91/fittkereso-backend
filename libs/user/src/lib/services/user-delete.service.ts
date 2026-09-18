import { ConflictException, Injectable } from '@nestjs/common';
import { UserRepository } from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from '@fittkereso-backend/supabase';

@Injectable()
export class UserDeleteService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly supabaseAuthAdmin: SupabaseAuthAdminService,
  ) {}

  /**
   * Deletes the Supabase account first, then the local row.
   *
   * TODO: once history/audit rows reference app_user, they should carry a
   * nullable FK (ON DELETE SET NULL) plus a frozen email snapshot, so a
   * deletion leaves history readable. If they instead end up with a
   * restricting FK, this is where a "still holds N records, reassign them
   * first" check belongs.
   */
  async delete(id: string, callerUserId: string): Promise<void> {
    if (id === callerUserId) {
      throw new ConflictException('You cannot delete your own account');
    }

    const user = await this.userRepository.findByIdOrFail(id);

    await this.supabaseAuthAdmin.deleteAccount(user.authUserId);
    await this.userRepository.deleteById(user.id);
  }
}
