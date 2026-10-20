import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SellerMemberRole,
  SellerMembership,
  SellerMembershipRepository,
  UserRepository,
} from '@fittkereso-backend/database';
import { EntityManager } from 'typeorm';

/**
 * Admin-side management of who works for which seller.
 *
 * The partner portal (fittkereso-frontend) manages the same table for a
 * shop's own team and applies the same rule: every seller keeps at least one
 * shop admin. Without one, nobody but a platform admin could manage the team.
 */
@Injectable()
export class SellerMembershipService {
  constructor(
    private readonly membershipRepository: SellerMembershipRepository,
    private readonly userRepository: UserRepository,
  ) {}

  async listForUser(userId: string): Promise<SellerMembership[]> {
    return this.membershipRepository.findForUser(userId);
  }

  async listForSeller(sellerId: string): Promise<SellerMembership[]> {
    return this.membershipRepository.findForSeller(sellerId);
  }

  /**
   * Adds the account to the seller in `role`, or changes its role there.
   * An unknown seller surfaces as a 404 from the row lock.
   */
  async upsert(
    userId: string,
    sellerId: string,
    role: SellerMemberRole,
  ): Promise<SellerMembership> {
    return this.membershipRepository.withSellerLock(sellerId, async (transaction) => {
      const user = await this.userRepository.findById(userId, transaction);
      if (!user) {
        throw new NotFoundException('Resource not found');
      }

      const existing = await this.membershipRepository.findOneFor(
        userId,
        sellerId,
        transaction,
      );

      if (existing) {
        if (existing.role === role) {
          return existing;
        }
        if (existing.role === SellerMemberRole.admin) {
          await this.assertNotLastAdmin(sellerId, transaction);
        }
        existing.role = role;

        return this.membershipRepository.save(existing, undefined, transaction);
      }

      const membership = new SellerMembership();
      membership.user = user;
      membership.seller = { id: sellerId } as SellerMembership['seller'];
      membership.role = role;
      await this.membershipRepository.save(membership, undefined, transaction);

      // Re-read so the response carries the seller's name, not just its id.
      return (await this.membershipRepository.findOneFor(
        userId,
        sellerId,
        transaction,
      )) as SellerMembership;
    });
  }

  /** Removes the account from the seller; the account itself stays. */
  async remove(userId: string, sellerId: string): Promise<void> {
    await this.membershipRepository.withSellerLock(sellerId, async (transaction) => {
      const existing = await this.membershipRepository.findOneFor(
        userId,
        sellerId,
        transaction,
      );
      if (!existing) {
        throw new NotFoundException('Resource not found');
      }
      if (existing.role === SellerMemberRole.admin) {
        await this.assertNotLastAdmin(sellerId, transaction);
      }

      await this.membershipRepository.deleteOne(existing.id, transaction);
    });
  }

  private async assertNotLastAdmin(
    sellerId: string,
    transaction: EntityManager,
  ): Promise<void> {
    const admins = await this.membershipRepository.countAdmins(sellerId, transaction);
    if (admins <= 1) {
      throw new ConflictException('A seller must keep at least one shop admin');
    }
  }
}
