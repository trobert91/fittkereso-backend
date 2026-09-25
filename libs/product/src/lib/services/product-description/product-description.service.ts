import { Injectable } from '@nestjs/common';
import { ProductSourceRecord } from '@fittkereso-backend/database';
import { htmlToText } from '@fittkereso-backend/utils';
import { maxBy, orderBy } from 'lodash';

/**
 * Shorter than this, a listing's description is no description: speedbike's
 * Árukereső feed carries only the article number (`<p>121210</p>`) for
 * hundreds of e-bikes.
 */
export const MIN_DESCRIPTION_LENGTH = 40;

/**
 * The product's description, from its records.
 *
 * The admin's own record (no source) wins whenever it holds one: that is where
 * an admin edit of the description lives. Otherwise the highest-priority
 * source with a real description wins, as plain text; among sources of equal
 * priority (other sellers) the longer text, then the lower source id, and
 * within one source (a product's sizes) the lower listing URL, so the result
 * never depends on which listing arrived first — record ids would.
 *
 * Every attached record counts, current or not, as for specs.
 */
@Injectable()
export class ProductDescriptionService {
  public pick(records: ProductSourceRecord[]): string | null {
    const admin = maxBy(
      records.filter((record) => !record.source && record.scrapedProduct?.description?.trim()),
      (record) => record.lastUpdated,
    )?.scrapedProduct?.description?.trim();
    if (admin) return admin;

    const candidates = records.flatMap((record) => {
      const html = record.source && record.scrapedProduct?.description;
      if (!record.source || !html) return [];
      const text = htmlToText(html);
      return text.length >= MIN_DESCRIPTION_LENGTH
        ? [{ record, source: record.source, text }]
        : [];
    });
    const [winner] = orderBy(
      candidates,
      [
        (candidate) => candidate.source.priority,
        (candidate) => candidate.text.length,
        (candidate) => candidate.source.id,
        (candidate) => candidate.record.url ?? '',
        (candidate) => candidate.text,
      ],
      ['desc', 'desc', 'asc', 'asc', 'asc'],
    );
    return winner?.text ?? null;
  }
}
