import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from './supabase-auth-admin.service';

/** The GoTrue-code to HTTP-status table, which is easy to extend carelessly. */
describe('SupabaseAuthAdminService', () => {
  function makeService(admin: Record<string, jest.Mock>) {
    const adminClient = {
      getClient: () => ({ auth: { admin } }),
    };

    return new SupabaseAuthAdminService(adminClient as never);
  }

  const createParams = {
    email: 'someone@example.com',
    password: 'temporary-password',
    name: 'Someone',
    role: UserRole.admin,
  };

  it('creates a confirmed account carrying the role and the hold', async () => {
    const createUser = jest
      .fn()
      .mockResolvedValue({ data: { user: { id: 'auth-id' } }, error: null });

    const id = await makeService({ createUser }).createAccount(createParams);

    expect(id).toBe('auth-id');
    expect(createUser).toHaveBeenCalledWith({
      email: 'someone@example.com',
      password: 'temporary-password',
      email_confirm: true,
      user_metadata: { name: 'Someone' },
      app_metadata: { role: UserRole.admin, password_change_required: true },
    });
  });

  it.each([
    ['email_exists', ConflictException],
    ['user_already_exists', ConflictException],
    ['weak_password', BadRequestException],
    ['validation_failed', BadRequestException],
    ['email_address_invalid', BadRequestException],
    ['user_not_found', NotFoundException],
  ])('maps GoTrue %s to the right exception', async (code, expected) => {
    const createUser = jest
      .fn()
      .mockResolvedValue({ data: null, error: { code, message: 'nope' } });

    await expect(
      makeService({ createUser }).createAccount(createParams),
    ).rejects.toBeInstanceOf(expected);
  });

  it('maps anything unrecognised to a 502', async () => {
    const createUser = jest.fn().mockResolvedValue({
      data: null,
      error: { code: 'something_new', message: 'nope' },
    });

    await expect(
      makeService({ createUser }).createAccount(createParams),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('passes GoTrue its own wording for policy failures', async () => {
    const createUser = jest.fn().mockResolvedValue({
      data: null,
      error: { code: 'weak_password', message: 'Password is too short' },
    });

    // The project's own policy may be stricter than ours, so its message is
    // the useful one to show.
    await expect(
      makeService({ createUser }).createAccount(createParams),
    ).rejects.toThrow('Password is too short');
  });

  it('only sends the metadata keys that are actually changing', async () => {
    const updateUserById = jest.fn().mockResolvedValue({ error: null });

    await makeService({ updateUserById }).updateAccountMetadata('auth-id', {
      passwordChangeRequired: false,
    });

    expect(updateUserById).toHaveBeenCalledWith('auth-id', {
      app_metadata: { password_change_required: false },
    });
  });

  it('skips the call entirely when there is nothing to change', async () => {
    const updateUserById = jest.fn();

    await makeService({ updateUserById }).updateAccountMetadata('auth-id', {});

    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('stays quiet about unknown addresses when generating a recovery token', async () => {
    const generateLink = jest
      .fn()
      .mockResolvedValue({ data: null, error: { code: 'user_not_found' } });

    // Null rather than a throw, so the caller can answer identically for
    // known and unknown addresses.
    await expect(
      makeService({ generateLink }).generateRecoveryToken('nobody@example.com'),
    ).resolves.toBeNull();
  });

  it('returns the hashed recovery token when one is issued', async () => {
    const generateLink = jest.fn().mockResolvedValue({
      data: { properties: { hashed_token: 'hash-value' } },
      error: null,
    });

    await expect(
      makeService({ generateLink }).generateRecoveryToken('someone@example.com'),
    ).resolves.toBe('hash-value');
  });

  it('pages through listUsers to find an account by email', async () => {
    const listUsers = jest
      .fn()
      .mockResolvedValueOnce({
        data: { users: new Array(1000).fill({ id: 'x', email: 'other@example.com' }) },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { users: [{ id: 'auth-id', email: 'Someone@Example.com' }] },
        error: null,
      });

    const found = await makeService({ listUsers }).findAccountByEmail(
      'someone@example.com',
    );

    expect(found).toEqual({ authUserId: 'auth-id', email: 'Someone@Example.com' });
    expect(listUsers).toHaveBeenCalledTimes(2);
  });

  it('returns null when no page contains the address', async () => {
    const listUsers = jest
      .fn()
      .mockResolvedValue({ data: { users: [] }, error: null });

    await expect(
      makeService({ listUsers }).findAccountByEmail('nobody@example.com'),
    ).resolves.toBeNull();
  });

  it('surfaces a deletion failure rather than swallowing it', async () => {
    const deleteUser = jest
      .fn()
      .mockResolvedValue({ error: { code: 'unexpected' } });

    await expect(
      makeService({ deleteUser }).deleteAccount('auth-id'),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
