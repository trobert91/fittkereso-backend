import { ConflictException, Injectable } from '@nestjs/common';
import {
  Seller,
  SellerMembership,
  SellerMembershipRepository,
  SellerRepository,
  User,
  UserRepository,
} from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from '@fittkereso-backend/supabase';
import { CustomLogger } from '@fittkereso-backend/logger';
import { UserCreateDto } from '../models';
import { normalizeEmail } from '../utils';

@Injectable()
export class UserCreateService {
  private readonly logger = new CustomLogger(UserCreateService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly supabaseAuthAdmin: SupabaseAuthAdminService,
    private readonly sellerRepository: SellerRepository,
    private readonly membershipRepository: SellerMembershipRepository,
  ) {}

  /**
   * Provisions an account in Supabase and mirrors it locally, with its seller
   * membership when one is asked for.
   *
   * Supabase is a separate system from our Postgres, so the two writes cannot
   * share a transaction. If the local write fails we therefore delete the
   * account we just created, otherwise a half-made account would linger in
   * Supabase: able to sign in, with no local row, and so unable to do anything
   * and impossible to manage from the admin UI. The row and the membership do
   * share one, so a failed membership undoes the row too.
   */
  async create(dto: UserCreateDto): Promise<User> {
    const email = normalizeEmail(dto.email);

    const existing = await this.userRepository.findByEmail(email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    // Checked before Supabase is touched: an unknown seller is a 404 with
    // nothing to undo.
    const seller = dto.sellerId
      ? await this.sellerRepository.findByIdOrFail(dto.sellerId)
      : null;

    const authUserId = await this.supabaseAuthAdmin.createAccount({
      email,
      password: dto.password,
      name: dto.name,
      role: dto.role,
    });

    try {
      return await this.userRepository.repo.manager.transaction(
        async (transaction) => {
          const user = new User();
          user.authUserId = authUserId;
          user.email = email;
          user.name = dto.name;
          user.role = dto.role;
          // Created with a temporary password, so hold the account at
          // set-password until its owner chooses their own.
          user.passwordChangeRequired = true;

          const saved = await this.userRepository.save(user, undefined, transaction);

          if (seller && dto.sellerRole) {
            await this.membershipRepository.save(
              this.membershipOf(saved, seller, dto),
              undefined,
              transaction,
            );
          }

          return saved;
        },
      );
    } catch (error) {
      await this.compensate(authUserId, email);
      // Rethrow the original failure, never the compensation's.
      throw error;
    }
  }

  private membershipOf(user: User, seller: Seller, dto: UserCreateDto): SellerMembership {
    const membership = new SellerMembership();
    membership.user = user;
    membership.seller = seller;
    membership.role = dto.sellerRole as SellerMembership['role'];

    return membership;
  }

  private async compensate(authUserId: string, email: string): Promise<void> {
    try {
      await this.supabaseAuthAdmin.deleteAccount(authUserId);
    } catch (compensationError) {
      // Nothing better to do than say so loudly: the account now exists in
      // Supabase with no local row, and needs deleting by hand.
      this.logger.error(
        'Failed to roll back the Supabase account after a local write failure',
        compensationError,
        { authUserId, email },
      );
    }
  }
}
