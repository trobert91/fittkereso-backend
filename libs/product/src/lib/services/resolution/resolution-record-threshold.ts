import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

/**
 * The lowest score a `ProductResolution` row is written above.
 *
 * Read from one place because two things depend on it agreeing with itself: the
 * recorder gates writes on it, and `outcomeTension` rescales against it to undo
 * the truncation those writes cause. A drift between the two would silently
 * skew every score computed from a truncated distribution.
 */
export function minScoreToRecord(config: DynamicConfigService): number {
  return (
    config.resolution?.minScoreToRecord ?? RESOLUTION_DEFAULTS.minScoreToRecord
  );
}
