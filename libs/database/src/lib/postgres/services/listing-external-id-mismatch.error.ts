/** The shape written into a failed task's `error` column for this failure. */
export interface ListingExternalIdMismatchDetail {
  kind: 'listing_external_id_mismatch';
  sourceId: string;
  sourceName: string;
  url: string;
  /** The externalId the list card stated for `url` (ProductImportTask.externalId). */
  expectedExternalId: string;
  /** The externalIds the page fetched from `url` states: its own and its offers'. */
  pageExternalIds: string[];
  message: string;
}

/**
 * A detail page answered with a different product than the list card that
 * queued it.
 *
 * Some shops never answer a product URL with a 404: ebikeshop redirects a
 * delisted product's URL to a fuzzy-matched other product, and the fetch
 * follows the redirect. Importing that page would file the other product's
 * specs, price and identity under this card's URL, so the import refuses.
 *
 * Its own class so the task managers can recognise it and mark the task
 * terminal: the same URL answers with the same other product on every retry.
 * It carries the ids, so the task row says what happened.
 */
export class ListingExternalIdMismatchError extends Error {
  public readonly detail: ListingExternalIdMismatchDetail;

  constructor(params: {
    source: { id: string; name: string };
    url: string;
    expectedExternalId: string;
    pageExternalIds: string[];
  }) {
    const { source, url, expectedExternalId, pageExternalIds } = params;
    const message =
      `${url} shows ${pageExternalIds.join(', ')}, but the "${source.name}" list card that queued it said ` +
      `${expectedExternalId}: the page is another product (a redirect?), and is not imported`;

    super(message);
    this.name = 'ListingExternalIdMismatchError';

    this.detail = {
      kind: 'listing_external_id_mismatch',
      sourceId: source.id,
      sourceName: source.name,
      url,
      expectedExternalId,
      pageExternalIds,
      message,
    };
  }
}

/** Whether a thrown value is this failure, for the task managers' catch blocks. */
export function isListingExternalIdMismatchError(
  error: unknown,
): error is ListingExternalIdMismatchError {
  return error instanceof ListingExternalIdMismatchError;
}
