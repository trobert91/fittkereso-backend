import { ConflictException } from '@nestjs/common';
import { SellerMemberRole, UserRole } from '@fittkereso-backend/database';
import { UserCreateService } from './user-create.service';

/**
 * The compensating delete is the point of these tests. Supabase and our
 * Postgres cannot share a transaction, so a local failure has to actively undo
 * the account that was already created - and it must not swallow the original
 * error while doing so.
 */
describe('UserCreateService', () => {
  const dto = {
    email: '  Someone@Example.COM ',
    password: 'temporary-password',
    name: 'Someone',
    role: UserRole.admin,
  };

  function makeService(overrides: {
    findByEmail?: jest.Mock;
    save?: jest.Mock;
    createAccount?: jest.Mock;
    deleteAccount?: jest.Mock;
    findSeller?: jest.Mock;
    saveMembership?: jest.Mock;
  }) {
    const userRepository = {
      findByEmail: overrides.findByEmail ?? jest.fn().mockResolvedValue(null),
      save: overrides.save ?? jest.fn(async (user) => user),
      // Runs the callback inline: the tests are about what is written, and
      // a failure inside the callback rejects the whole transaction.
      repo: {
        manager: { transaction: jest.fn(async (work) => work('transaction')) },
      },
    };
    const supabaseAuthAdmin = {
      createAccount:
        overrides.createAccount ?? jest.fn().mockResolvedValue('auth-id'),
      deleteAccount: overrides.deleteAccount ?? jest.fn().mockResolvedValue(undefined),
    };
    const sellerRepository = {
      findByIdOrFail:
        overrides.findSeller ?? jest.fn().mockResolvedValue({ id: 'seller-id' }),
    };
    const membershipRepository = {
      save: overrides.saveMembership ?? jest.fn(async (membership) => membership),
    };

    return {
      service: new UserCreateService(
        userRepository as never,
        supabaseAuthAdmin as never,
        sellerRepository as never,
        membershipRepository as never,
      ),
      userRepository,
      supabaseAuthAdmin,
      sellerRepository,
      membershipRepository,
    };
  }

  it('normalises the email before doing anything with it', async () => {
    const { service, userRepository, supabaseAuthAdmin } = makeService({});

    const created = await service.create(dto);

    expect(userRepository.findByEmail).toHaveBeenCalledWith(
      'someone@example.com',
    );
    expect(supabaseAuthAdmin.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'someone@example.com' }),
    );
    expect(created.email).toBe('someone@example.com');
  });

  it('creates the account held on its temporary password', async () => {
    const { service } = makeService({});

    const created = await service.create(dto);

    expect(created.passwordChangeRequired).toBe(true);
    expect(created.role).toBe(UserRole.admin);
    expect(created.authUserId).toBe('auth-id');
  });

  it('refuses a duplicate email before touching Supabase', async () => {
    const { service, supabaseAuthAdmin } = makeService({
      findByEmail: jest.fn().mockResolvedValue({ id: 'existing' }),
    });

    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(supabaseAuthAdmin.createAccount).not.toHaveBeenCalled();
  });

  it('deletes the Supabase account when the local write fails', async () => {
    const localFailure = new Error('local write failed');
    const { service, supabaseAuthAdmin } = makeService({
      save: jest.fn().mockRejectedValue(localFailure),
    });

    await expect(service.create(dto)).rejects.toBe(localFailure);
    expect(supabaseAuthAdmin.deleteAccount).toHaveBeenCalledWith('auth-id');
  });

  it('rethrows the original failure, not the compensation failure', async () => {
    const localFailure = new Error('local write failed');
    const { service } = makeService({
      save: jest.fn().mockRejectedValue(localFailure),
      deleteAccount: jest.fn().mockRejectedValue(new Error('rollback failed')),
    });

    // The rollback failure is logged, but the caller must still be told what
    // actually went wrong.
    await expect(service.create(dto)).rejects.toBe(localFailure);
  });

  it('does not try to compensate when Supabase itself refused', async () => {
    const { service, supabaseAuthAdmin } = makeService({
      createAccount: jest.fn().mockRejectedValue(new ConflictException()),
    });

    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(supabaseAuthAdmin.deleteAccount).not.toHaveBeenCalled();
  });

  describe('with a seller membership', () => {
    const partnerDto = {
      ...dto,
      role: UserRole.user,
      sellerId: 'seller-id',
      sellerRole: SellerMemberRole.reader,
    };

    it('saves the membership in the same transaction as the row', async () => {
      const { service, userRepository, membershipRepository } = makeService({});

      const created = await service.create(partnerDto);

      expect(userRepository.save).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        'transaction',
      );
      expect(membershipRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          user: created,
          seller: { id: 'seller-id' },
          role: SellerMemberRole.reader,
        }),
        undefined,
        'transaction',
      );
    });

    it('refuses an unknown seller before touching Supabase', async () => {
      const notFound = new Error('EntityNotFound');
      const { service, supabaseAuthAdmin } = makeService({
        findSeller: jest.fn().mockRejectedValue(notFound),
      });

      await expect(service.create(partnerDto)).rejects.toBe(notFound);
      expect(supabaseAuthAdmin.createAccount).not.toHaveBeenCalled();
    });

    it('deletes the Supabase account when the membership write fails', async () => {
      const membershipFailure = new Error('membership write failed');
      const { service, supabaseAuthAdmin } = makeService({
        saveMembership: jest.fn().mockRejectedValue(membershipFailure),
      });

      await expect(service.create(partnerDto)).rejects.toBe(membershipFailure);
      expect(supabaseAuthAdmin.deleteAccount).toHaveBeenCalledWith('auth-id');
    });

    it('writes no membership when none is asked for', async () => {
      const { service, membershipRepository, sellerRepository } = makeService({});

      await service.create(dto);

      expect(sellerRepository.findByIdOrFail).not.toHaveBeenCalled();
      expect(membershipRepository.save).not.toHaveBeenCalled();
    });
  });
});
