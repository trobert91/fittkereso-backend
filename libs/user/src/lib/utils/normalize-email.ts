/**
 * GoTrue stores addresses lower-cased and we match on equality, so every
 * address entering the system goes through here first.
 */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();
