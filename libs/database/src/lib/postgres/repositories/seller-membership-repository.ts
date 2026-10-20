import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { BasePostgresRepository } from './base-postgres-repository';
import { SellerMembership } from '../models/seller-membership.entity';
import { Seller } from '../models/seller.entity';
import { SellerMemberRole } from '../types/seller-member-role';

@Injectable()
export class SellerMembershipRepository extends BasePostgresRepository<SellerMembership> {
  constructor(
    @InjectRepository(SellerMembership, 'postgres')
    repository: Repository<SellerMembership>,
  ) {
    super(repository, SellerMembership);
  }

  /** An account's memberships with their sellers, by seller name. */
  async findForUser(userId: string): Promise<SellerMembership[]> {
    return this.repo.find({
      where: { user: { id: userId } },
      relations: { seller: true },
      order: { seller: { name: 'ASC' } },
    });
  }

  /** A seller's members with their accounts, by email. */
  async findForSeller(sellerId: string): Promise<SellerMembership[]> {
    return this.repo.find({
      where: { seller: { id: sellerId } },
      relations: { user: true },
      order: { user: { email: 'ASC' } },
    });
  }

  async findOneFor(
    userId: string,
    sellerId: string,
    transaction?: EntityManager,
  ): Promise<SellerMembership | null> {
    const manager = transaction ?? this.repo.manager;

    return manager.findOne(SellerMembership, {
      where: { user: { id: userId }, seller: { id: sellerId } },
      relations: { seller: true },
    });
  }

  async countAdmins(sellerId: string, transaction: EntityManager): Promise<number> {
    return transaction.count(SellerMembership, {
      where: { seller: { id: sellerId }, role: SellerMemberRole.admin },
    });
  }

  /**
   * Runs `work` in a transaction holding a row lock on the seller.
   *
   * Every membership change of one seller goes through here, so two of them
   * cannot interleave: without it, two admins demoting each other at once
   * would both count two admins and leave the seller with none.
   */
  async withSellerLock<T>(
    sellerId: string,
    work: (transaction: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.repo.manager.transaction(async (transaction) => {
      await transaction
        .createQueryBuilder(Seller, 'seller')
        .setLock('pessimistic_write')
        .where(`seller.${nameOf<Seller>('id')} = :sellerId`, { sellerId })
        .getOneOrFail();

      return work(transaction);
    });
  }

  async deleteOne(id: string, transaction: EntityManager): Promise<void> {
    await transaction.delete(SellerMembership, { id });
  }
}
