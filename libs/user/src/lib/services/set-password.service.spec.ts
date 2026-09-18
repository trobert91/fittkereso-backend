import { SetPasswordService } from './set-password.service';

/**
 * Four effects have to happen together. Missing the metadata mirror or the
 * fresh session is what produces the redirect loop where a user sets their
 * password successfully and is bounced straight back to the set-password page.
 */
describe('SetPasswordService', () => {
  function makeService(overrides: { login?: jest.Mock } = {}) {
    const user = {
      id: 'local-id',
      authUserId: 'auth-id',
      email: 'someone@example.com',
      passwordChangeRequired: true,
    };
    const userRepository = {
      findByIdOrFail: jest.fn().mockResolvedValue(user),
      save: jest.fn(async (saved) => saved),
    };
    const supabaseAuthAdmin = {
      updateAccountPassword: jest.fn().mockResolvedValue(undefined),
      updateAccountMetadata: jest.fn().mockResolvedValue(undefined),
    };
    const loginService = {
      login:
        overrides.login ??
        jest.fn().mockResolvedValue({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
        }),
    };

    return {
      service: new SetPasswordService(
        userRepository as never,
        supabaseAuthAdmin as never,
        loginService as never,
      ),
      user,
      userRepository,
      supabaseAuthAdmin,
      loginService,
    };
  }

  it('changes the password in Supabase', async () => {
    const { service, supabaseAuthAdmin } = makeService();

    await service.setPassword({ userId: 'local-id', password: 'chosen-one' });

    expect(supabaseAuthAdmin.updateAccountPassword).toHaveBeenCalledWith(
      'auth-id',
      'chosen-one',
    );
  });

  it('clears the hold on the local row', async () => {
    const { service, user, userRepository } = makeService();

    await service.setPassword({ userId: 'local-id', password: 'chosen-one' });

    expect(user.passwordChangeRequired).toBe(false);
    expect(userRepository.save).toHaveBeenCalledWith(user);
  });

  it('clears the advisory app_metadata mirror too', async () => {
    const { service, supabaseAuthAdmin } = makeService();

    await service.setPassword({ userId: 'local-id', password: 'chosen-one' });

    expect(supabaseAuthAdmin.updateAccountMetadata).toHaveBeenCalledWith(
      'auth-id',
      { passwordChangeRequired: false },
    );
  });

  it('signs in again rather than refreshing, and returns the new session', async () => {
    const { service, loginService } = makeService();

    const result = await service.setPassword({
      userId: 'local-id',
      password: 'chosen-one',
    });

    // A password change revokes existing refresh tokens, so refreshing here
    // would always fail; signing in with the new password is the only way to
    // mint a session that reflects the change.
    expect(loginService.login).toHaveBeenCalledWith(
      'someone@example.com',
      'chosen-one',
    );
    expect(result).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
  });

  it('still succeeds when the new session cannot be issued', async () => {
    const { service } = makeService({
      login: jest.fn().mockRejectedValue(new Error('sign-in failed')),
    });

    // The password really was changed, so failing the request would be a lie.
    await expect(
      service.setPassword({ userId: 'local-id', password: 'chosen-one' }),
    ).resolves.toEqual({});
  });
});
