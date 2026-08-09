/** Growing-cooldown parameters for the backoff baked into `attemptResolutionAfter`. */
export interface BackfillCooldown {
  baseCooldownHours: number;
  backoffBase: number;
  maxCooldownHours: number;
}

/**
 * Cooldown in hours before the next attempt, growing with attempt count and
 * capped — there is no give-up, a perennially-unresolvable ref just retries at
 * `maxCooldownHours` cadence indefinitely (until it ages out of the candidate
 * window). The materialised `attemptResolutionAfter` is what the candidate query
 * orders by, so this backoff IS the priority signal.
 */
export function effectiveCooldownHours(
  attemptCount: number,
  cooldown: BackfillCooldown,
): number {
  const raw =
    cooldown.baseCooldownHours * Math.pow(cooldown.backoffBase, attemptCount);
  return Math.min(raw, cooldown.maxCooldownHours);
}
