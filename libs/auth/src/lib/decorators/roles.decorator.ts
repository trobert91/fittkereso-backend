import { Reflector } from '@nestjs/core';
import { UserRole } from '@fittkereso-backend/database';

/**
 * Access levels are a hierarchy, so routes declare a *minimum* rather than a
 * set: @MinRole(UserRole.admin) covers superadmin for free, and adding a
 * fourth level later does not mean revisiting every annotation.
 *
 * Keep this in step with the UserRole enum - a missing entry here makes the
 * comparison in RoleGuard undefined, which would fail open.
 */
export const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.user]: 0,
  [UserRole.admin]: 1,
  [UserRole.superadmin]: 2,
};

/**
 * The minimum role a route requires.
 *
 * RoleGuard reads this with getAllAndOverride, which is override rather than
 * merge: a handler-level annotation replaces the class-level one. Use that
 * deliberately and in the fail-closed direction - put the stricter level on
 * the class and let individual read handlers opt *down* - so that forgetting
 * an annotation denies a read rather than allowing a mutation.
 */
export const MinRole = Reflector.createDecorator<UserRole>();
