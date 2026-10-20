/**
 * Platform access levels, ordered least to most privileged.
 *
 * The rank order matters: RoleGuard compares roles by rank, so `admin`
 * satisfies a `@MinRole(UserRole.user)` route. Keep ROLE_RANK in
 * libs/auth in step with any value added here.
 *
 * What an account may do for a particular seller is not a platform role: it
 * is the role on its SellerMembership row.
 */
export enum UserRole {
  /**
   * No access to the admin surface: partner (shop) accounts, whose access is
   * their seller memberships, and later private sellers.
   */
  user = 'user',
  /** The admin app and every admin route, user management included. */
  admin = 'admin',
}
