/**
 * What KIND of thing wrote a product source history row, stated rather than
 * inferred.
 *
 * `actorUser` is nullable with ON DELETE SET NULL, so null is overloaded: it
 * means both "the machine did this" and "a person did this and was later
 * deleted". Those are different facts, and conflating them makes a deleted
 * admin's work read as the scheduler's — a wrong attribution, which is worse
 * than a blank one in a record that exists to say who did what. This is the
 * discriminator that keeps them apart.
 */
export const PRODUCT_SOURCE_ACTOR_TYPES = ['user', 'system'] as const;

export type ProductSourceActorType = (typeof PRODUCT_SOURCE_ACTOR_TYPES)[number];

/**
 * Who is making a change, resolved by the caller rather than read from a
 * request deep inside a service.
 *
 * `userId` is the LOCAL app_user primary key, never the Supabase `sub` —
 * AuthenticatedUser.id is already that id, and User's own comment explains
 * why history should reference it: re-pointing a Supabase project must not
 * orphan attribution.
 *
 * `label` is frozen onto the row at write time so the history stays readable
 * after the account it names is deleted. For a system actor it says which
 * machine path acted: 'scheduler', 'mcp', 'seed'.
 */
export interface ProductSourceActor {
  type: ProductSourceActorType;
  userId?: string | null;
  label?: string | null;
}

/** The scheduler, a script or any other non-human write path. */
export const systemActor = (label: string): ProductSourceActor => ({
  type: 'system',
  label,
});
