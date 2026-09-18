import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ALLOW_PASSWORD_CHANGE_REQUIRED_KEY,
  IS_PUBLIC_KEY,
} from '@fittkereso-backend/utils';
import { UserRole } from '@fittkereso-backend/database';
import { AuthGuard } from './auth-guard';
import { AuthenticatedUser } from '../models/auth-user';

describe('AuthGuard', () => {
  function makeUser(overrides: Partial<AuthenticatedUser> = {}) {
    return {
      id: 'local-id',
      authUserId: 'auth-id',
      email: 'someone@example.com',
      name: 'Someone',
      role: UserRole.admin,
      passwordChangeRequired: false,
      ...overrides,
    } as AuthenticatedUser;
  }

  function makeContext(request: Record<string, unknown>): ExecutionContext {
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function makeGuard(options: {
    metadata?: Record<string, boolean>;
    getUser?: jest.Mock;
  }) {
    const metadata = options.metadata ?? {};
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata[key]),
    };
    const userAuthService = { getUser: options.getUser ?? jest.fn() };

    return new AuthGuard(reflector as never, userAuthService as never);
  }

  it('lets a @Public route through without looking at the token', async () => {
    const getUser = jest.fn();
    const guard = makeGuard({ metadata: { [IS_PUBLIC_KEY]: true }, getUser });

    await expect(guard.canActivate(makeContext({ headers: {} }))).resolves.toBe(
      true,
    );
    expect(getUser).not.toHaveBeenCalled();
  });

  it('refuses a request with no token at all', async () => {
    const guard = makeGuard({});

    await expect(
      guard.canActivate(makeContext({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a bearer token and attaches the user', async () => {
    const user = makeUser();
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer token-value' },
    };
    const getUser = jest.fn().mockResolvedValue(user);
    const guard = makeGuard({ getUser });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(getUser).toHaveBeenCalledWith('token-value');
    expect(request['user']).toBe(user);
  });

  it('falls back to the access_token cookie', async () => {
    const getUser = jest.fn().mockResolvedValue(makeUser());
    const guard = makeGuard({ getUser });

    await guard.canActivate(
      makeContext({ headers: {}, cookies: { access_token: 'cookie-value' } }),
    );

    expect(getUser).toHaveBeenCalledWith('cookie-value');
  });

  it('refuses when the account cannot be resolved', async () => {
    const guard = makeGuard({
      getUser: jest.fn().mockRejectedValue(new Error('no local row')),
    });

    await expect(
      guard.canActivate(
        makeContext({ headers: { authorization: 'Bearer t' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses with 403, not 401, while a password change is pending', async () => {
    const guard = makeGuard({
      getUser: jest
        .fn()
        .mockResolvedValue(makeUser({ passwordChangeRequired: true })),
    });

    // 401 would send the frontend off to refresh a token that is not the
    // problem, and then to the login page rather than to set-password.
    await expect(
      guard.canActivate(
        makeContext({ headers: { authorization: 'Bearer t' } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an @AllowPasswordChangeRequired route through while held', async () => {
    const guard = makeGuard({
      metadata: { [ALLOW_PASSWORD_CHANGE_REQUIRED_KEY]: true },
      getUser: jest
        .fn()
        .mockResolvedValue(makeUser({ passwordChangeRequired: true })),
    });

    await expect(
      guard.canActivate(makeContext({ headers: { authorization: 'Bearer t' } })),
    ).resolves.toBe(true);
  });
});
