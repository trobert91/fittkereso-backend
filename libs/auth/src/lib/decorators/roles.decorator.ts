import { Reflector } from '@nestjs/core';
import { UserRole } from '@fittkereso-backend/database';

/**
 * Access levels are a hierarchy, so routes declare a *minimum* rather than a
 * set: adding a level later does not mean revisiting every annotation.
 *
 * Keep this in step with the UserRole enum - a missing entry here makes the
 * comparison in RoleGuard undefined, which would fail open.
 */
export const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.user]: 0,
  [UserRole.admin]: 1,
};

/**
 * The minimum role a route requires.
 *
 * RoleGuard reads this with getAllAndOverride, which is override rather than
 * merge: a handler-level annotation replaces the class-level one. Use that
 * deliberately and in the fail-closed direction - put the stricter level on
 * the class - so that forgetting an annotation denies rather than allows.
 *
 * The admin controllers carry @MinRole(UserRole.admin) on the class and no
 * handler opts down: a `user` account is a partner account, and must not read
 * the admin surface.
 */
export const MinRole = Reflector.createDecorator<UserRole>();
