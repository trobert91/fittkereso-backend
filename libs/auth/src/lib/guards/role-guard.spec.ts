import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@fittkereso-backend/database';
import { RoleGuard } from './role-guard';
import { AuthenticatedUser } from '../models/auth-user';

/**
 * These cover the two bugs the previous implementation shipped with: it read
 * handler metadata only (so class-level @Roles never applied), and it compared
 * roles with AND rather than OR.
 */
describe('RoleGuard', () => {
  const handler = () => undefined;
  const controllerClass = class {};

  function makeContext(user?: Partial<AuthenticatedUser>): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => controllerClass,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  function makeGuard(minRole: UserRole | undefined, capture?: unknown[][]) {
    const reflector = {
      getAllAndOverride: jest.fn((key: unknown, targets: unknown[]) => {
        capture?.push(targets);
        return minRole;
      }),
    };

    return new RoleGuard(reflector as never);
  }

  it('allows an unannotated route through', () => {
    expect(makeGuard(undefined).canActivate(makeContext())).toBe(true);
  });

  it('reads handler metadata before class metadata', () => {
    const capture: unknown[][] = [];
    makeGuard(UserRole.user, capture).canActivate(
      makeContext({ role: UserRole.user }),
    );

    expect(capture[0]).toEqual([handler, controllerClass]);
  });

  it('allows a role of exactly the required rank', () => {
    expect(
      makeGuard(UserRole.admin).canActivate(makeContext({ role: UserRole.admin })),
    ).toBe(true);
  });

  it('allows a role above the required rank', () => {
    expect(
      makeGuard(UserRole.admin).canActivate(
        makeContext({ role: UserRole.superadmin }),
      ),
    ).toBe(true);
  });

  it('refuses a role below the required rank', () => {
    expect(() =>
      makeGuard(UserRole.admin).canActivate(makeContext({ role: UserRole.user })),
    ).toThrow(ForbiddenException);
  });

  it('refuses a user reaching a superadmin route', () => {
    expect(() =>
      makeGuard(UserRole.superadmin).canActivate(
        makeContext({ role: UserRole.admin }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('refuses when a role is required but no user was attached', () => {
    expect(() => makeGuard(UserRole.user).canActivate(makeContext())).toThrow(
      UnauthorizedException,
    );
  });
});
