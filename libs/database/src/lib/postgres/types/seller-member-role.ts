/**
 * What an account may do for one seller, ordered least to most privileged.
 * Labelled "Shop reader / writer / admin" in the UIs.
 *
 * Separate from UserRole on purpose: a platform role says what an account may
 * do on fittkereso as a whole, this says what it may do for one shop, and one
 * account can hold different roles at different shops.
 */
export enum SellerMemberRole {
  /** Sees the shop's pages in the partner portal. */
  reader = 'reader',
  /** Reader, plus editing the shop's data. */
  writer = 'writer',
  /** Writer, plus managing the shop's team. Every seller keeps at least one. */
  admin = 'admin',
}

/** Rank order for "at least this role" checks; keep in step with the enum. */
export const SELLER_MEMBER_ROLE_RANK: Record<SellerMemberRole, number> = {
  [SellerMemberRole.reader]: 0,
  [SellerMemberRole.writer]: 1,
  [SellerMemberRole.admin]: 2,
};
