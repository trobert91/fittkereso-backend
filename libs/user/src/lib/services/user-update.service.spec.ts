import { BadRequestException, ConflictException } from '@nestjs/common';
import { User, UserRole } from '@fittkereso-backend/database';
import { UserUpdateService } from './user-update.service';

/**
 * The self-demotion guard is the point of these tests: an admin who takes
 * their own admin role away is locked out of the admin app on the next
 * request, so the API refuses it the way it refuses self-delete.
 */
describe('UserUpdateService', () => {
  const ADMIN_ID = 'admin-id';

  function makeUser(overrides: Partial<User> = {}): User {
    return Object.assign(new User(), {
      id: ADMIN_ID,
      authUserId: 'auth-id',
      email: 'admin@example.com',
      name: 'Admin',
      role: UserRole.admin,
      passwordChangeRequired: false,
      ...overrides,
    });
  }

  function makeService(user: User) {
    const userRepository = {
      findByIdOrFail: jest.fn().mockResolvedValue(user),
      findByEmail: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (saved) => saved),
    };
    const supabaseAuthAdmin = {
      updateAccountEmail: jest.fn().mockResolvedValue(undefined),
      updateAccountMetadata: jest.fn().mockResolvedValue(undefined),
    };

    return {
      service: new UserUpdateService(
        userRepository as never,
        supabaseAuthAdmin as never,
      ),
      userRepository,
      supabaseAuthAdmin,
    };
  }

  it('refuses to take the caller their own admin role', async () => {
    const { service, userRepository, supabaseAuthAdmin } = makeService(
      makeUser(),
    );

    await expect(
      service.update(ADMIN_ID, { role: UserRole.user }, ADMIN_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(supabaseAuthAdmin.updateAccountMetadata).not.toHaveBeenCalled();
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('lets the caller resend their own admin role unchanged', async () => {
    const { service } = makeService(makeUser());

    const updated = await service.update(
      ADMIN_ID,
      { role: UserRole.admin, name: 'Renamed' },
      ADMIN_ID,
    );

    expect(updated.role).toBe(UserRole.admin);
    expect(updated.name).toBe('Renamed');
  });

  it('lets an admin demote someone else and mirrors the role', async () => {
    const other = makeUser({ id: 'other-id', authUserId: 'other-auth' });
    const { service, supabaseAuthAdmin } = makeService(other);

    const updated = await service.update(
      'other-id',
      { role: UserRole.user },
      ADMIN_ID,
    );

    expect(updated.role).toBe(UserRole.user);
    expect(supabaseAuthAdmin.updateAccountMetadata).toHaveBeenCalledWith(
      'other-auth',
      { role: UserRole.user, passwordChangeRequired: undefined },
    );
  });

  it('refuses an update that changes nothing', async () => {
    const { service } = makeService(makeUser());

    await expect(service.update(ADMIN_ID, {}, ADMIN_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
