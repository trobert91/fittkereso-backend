import { ConflictException, NotFoundException } from '@nestjs/common';
import { SellerMemberRole } from '@fittkereso-backend/database';
import { SellerMembershipService } from './seller-membership.service';

/**
 * The last-shop-admin rule is the point of these tests: a seller left with no
 * shop admin has nobody but a platform admin to manage its team.
 */
describe('SellerMembershipService', () => {
  const SELLER_ID = 'seller-id';
  const USER_ID = 'user-id';

  function makeService(options: {
    existing?: { id: string; role: SellerMemberRole } | null;
    admins?: number;
    user?: { id: string } | null;
  }) {
    const existing =
      options.existing === undefined ? null : options.existing;
    const membershipRepository = {
      withSellerLock: jest.fn(async (_sellerId, work) => work('transaction')),
      findOneFor: jest.fn().mockResolvedValue(existing),
      countAdmins: jest.fn().mockResolvedValue(options.admins ?? 1),
      save: jest.fn(async (membership) => membership),
      deleteOne: jest.fn().mockResolvedValue(undefined),
    };
    const userRepository = {
      findById: jest
        .fn()
        .mockResolvedValue(options.user === undefined ? { id: USER_ID } : options.user),
    };

    return {
      service: new SellerMembershipService(
        membershipRepository as never,
        userRepository as never,
      ),
      membershipRepository,
    };
  }

  describe('upsert', () => {
    it('adds a new membership under the seller lock', async () => {
      const { service, membershipRepository } = makeService({});

      await service.upsert(USER_ID, SELLER_ID, SellerMemberRole.reader);

      expect(membershipRepository.withSellerLock).toHaveBeenCalledWith(
        SELLER_ID,
        expect.any(Function),
      );
      expect(membershipRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          user: { id: USER_ID },
          seller: { id: SELLER_ID },
          role: SellerMemberRole.reader,
        }),
        undefined,
        'transaction',
      );
    });

    it('refuses an unknown account', async () => {
      const { service } = makeService({ user: null });

      await expect(
        service.upsert(USER_ID, SELLER_ID, SellerMemberRole.reader),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to demote the last shop admin', async () => {
      const { service, membershipRepository } = makeService({
        existing: { id: 'm', role: SellerMemberRole.admin },
        admins: 1,
      });

      await expect(
        service.upsert(USER_ID, SELLER_ID, SellerMemberRole.writer),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(membershipRepository.save).not.toHaveBeenCalled();
    });

    it('demotes a shop admin when another one remains', async () => {
      const { service } = makeService({
        existing: { id: 'm', role: SellerMemberRole.admin },
        admins: 2,
      });

      const updated = await service.upsert(
        USER_ID,
        SELLER_ID,
        SellerMemberRole.writer,
      );

      expect(updated.role).toBe(SellerMemberRole.writer);
    });

    it('leaves an unchanged role alone', async () => {
      const { service, membershipRepository } = makeService({
        existing: { id: 'm', role: SellerMemberRole.admin },
        admins: 1,
      });

      await service.upsert(USER_ID, SELLER_ID, SellerMemberRole.admin);

      expect(membershipRepository.countAdmins).not.toHaveBeenCalled();
      expect(membershipRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('refuses to remove the last shop admin', async () => {
      const { service, membershipRepository } = makeService({
        existing: { id: 'm', role: SellerMemberRole.admin },
        admins: 1,
      });

      await expect(service.remove(USER_ID, SELLER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(membershipRepository.deleteOne).not.toHaveBeenCalled();
    });

    it('removes a member who is not the last shop admin', async () => {
      const { service, membershipRepository } = makeService({
        existing: { id: 'm', role: SellerMemberRole.reader },
      });

      await service.remove(USER_ID, SELLER_ID);

      expect(membershipRepository.countAdmins).not.toHaveBeenCalled();
      expect(membershipRepository.deleteOne).toHaveBeenCalledWith('m', 'transaction');
    });

    it('answers 404 for an account that is not a member', async () => {
      const { service } = makeService({ existing: null });

      await expect(service.remove(USER_ID, SELLER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
