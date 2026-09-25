import { ProductSourceRecord } from '@fittkereso-backend/database';
import { groupBy, maxBy } from 'lodash';

/**
 * Dedupes a ProductModel's sources down to the most recently updated row
 * per distinct ProductSource (or 'manual' for sourceless/admin-entered
 * rows), so a source that was re-scraped multiple times only contributes
 * its latest data to a merge. What ProductNameMergeService.mergeNames
 * (brand/model/etc.) votes on; the specs vote per seller instead
 * (groupRecordsBySeller).
 */
export function getLatestSourcePerSource(
  sources: ProductSourceRecord[],
): ProductSourceRecord[] {
  const bySource = groupBy(sources, (s) => s.source?.id ?? 'manual');
  return Object.values(bySource).map(
    (entries) => maxBy(entries, (e) => e.lastUpdated)!,
  );
}
