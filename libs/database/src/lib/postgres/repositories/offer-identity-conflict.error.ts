export interface OfferIdentityConflictDetails {
  externalId: string;
  sellerId: string;
  offerId: string;
  /** The product the offer is currently bound to. */
  existingModelId: string;
  /** The product the importing source resolved for the same listing. */
  incomingModelId: string;
}

/**
 * Two sources claim one seller listing belongs to two different products.
 *
 * Raised by OfferComposerService when a listing's product is not the one the
 * seller's offer already sits on. It is a genuine
 * identity disagreement rather than a transient failure, so retrying achieves
 * nothing — one of the two sources has resolved the wrong product, and which
 * one is a question only the data answers.
 *
 * Thrown rather than reconciled on purpose. Both silent options are bad: moving
 * the offer to the incoming model silently relocates a listing, and leaving it
 * put (the original behaviour) silently strands the incoming model with no
 * offer, hence no price and no place in price-sorted search. Failing loudly on
 * one offer, while the rest of the import continues, is the only outcome that
 * surfaces the problem where somebody can fix it.
 */
export class OfferIdentityConflictError extends Error {
  constructor(readonly details: OfferIdentityConflictDetails) {
    super(
      `Offer ${details.offerId} (seller ${details.sellerId}, externalId "${details.externalId}") ` +
        `is bound to product ${details.existingModelId}, but the importing source resolved ` +
        `product ${details.incomingModelId} for the same listing. Refusing to rebind it — ` +
        `one of the two sources has the wrong product.`,
    );
    this.name = 'OfferIdentityConflictError';
  }
}
