import { ProductSourceRecord, ProductSpecs } from '@fittkereso-backend/database';
import { isSpecValueDefined } from '@fittkereso-backend/utils';
import { groupBy, maxBy, orderBy } from 'lodash';

/**
 * A product's records as spec candidates: one per seller, plus the admin's.
 *
 * Spec agreement counts sellers, not sources, so one shop's three sources are
 * one vote and cannot outvote two other shops. Within a seller the sources do
 * not vote: for each key, the value comes from the seller's highest-priority
 * record that has one, the newest on a tie — so a feed's specs win and a lower
 * source only fills gaps.
 *
 * Every attached record counts, current or not, so a sold-out listing's
 * specs stay on the product. A candidate carries the seller's highest-priority
 * source, which is what the merge's last tie-break reads. The admin's record
 * (no source) is a candidate of its own, the newest one when there are several.
 *
 * Records must be loaded with `source.seller`; a record whose seller is
 * missing counts as a seller of its own.
 */
export function groupRecordsBySeller(
  records: ProductSourceRecord[],
): ProductSourceRecord[] {
  const [sourced, manual] = [
    records.filter((record) => record.source),
    records.filter((record) => !record.source),
  ];
  const bySeller = groupBy(
    sourced,
    (record) => record.source?.seller?.id ?? `source:${record.source?.id}`,
  );

  const candidates = Object.values(bySeller).map(sellerCandidate);
  const newestManual = maxBy(manual, (record) => record.lastUpdated);
  return newestManual ? [...candidates, newestManual] : candidates;
}

function sellerCandidate(records: ProductSourceRecord[]): ProductSourceRecord {
  const ranked = orderBy(
    records,
    [(record) => record.source?.priority ?? 0, (record) => record.lastUpdated],
    ['desc', 'desc'],
  );
  if (ranked.length === 1) return ranked[0];

  const specs: ProductSpecs = {};
  for (const record of ranked) {
    for (const [key, value] of Object.entries(record.scrapedProduct?.specs ?? {})) {
      if (isSpecValueDefined(value) && !isSpecValueDefined(specs[key])) {
        specs[key] = value;
      }
    }
  }

  const [top] = ranked;
  return Object.assign(new ProductSourceRecord(), {
    id: top.id,
    source: top.source,
    scrapedProduct: { ...top.scrapedProduct, specs },
    lastUpdated: maxBy(ranked, (record) => record.lastUpdated)?.lastUpdated ?? top.lastUpdated,
  });
}
