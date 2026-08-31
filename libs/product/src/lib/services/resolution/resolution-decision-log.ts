import type { ProductResolutionDecisionEntry } from '@fittkereso-backend/database';
import { last } from 'lodash';

/**
 * The most recent decision that actually changed the catalog.
 *
 * Shared because two separate things key off it and must not disagree: which
 * correction can reverse the current state (`ProductResolutionStateService`),
 * and what is at stake in reviewing the row (`ProductResolutionPriorityService`).
 * Both are answers about the same entry.
 */
export function findLastPerformedDecision(
  decisions?: ProductResolutionDecisionEntry[],
): ProductResolutionDecisionEntry | undefined {
  return last((decisions ?? []).filter((entry) => entry.actionPerformed));
}
