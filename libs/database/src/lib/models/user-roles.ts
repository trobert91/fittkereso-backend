/**
 * Admin access levels, ordered least to most privileged.
 *
 * The rank order matters: RoleGuard compares roles by rank, so `admin`
 * satisfies a `@MinRole(UserRole.user)` route. Keep ROLE_RANK in
 * libs/auth in step with any value added here.
 */
export enum UserRole {
  /** Read-only access to the admin surface. */
  user = 'user',
  /** Full operational access: products, sellers, scraping, moderation. */
  admin = 'admin',
  /** Everything admin can do, plus user management. */
  superadmin = 'superadmin',
}
