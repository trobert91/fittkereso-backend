import { AssembleOfferOp, ProductSpecs } from '@fittkereso-backend/database';
import { OpHandler } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { RawOfferRecord } from '../scrape-interpreter.service';

function toFiniteNumber(value: unknown): number | undefined {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : undefined;
  return Number.isFinite(num) ? num : undefined;
}

// Assembles one RawOfferRecord from independent sub-pipelines run against
// the current (typically item-scoped, under forEachItem) context. Returns
// undefined — dropped by forEachItem's default skipEmptyResults — when
// sellerName/price don't resolve, mirroring the previous single-offer
// runDetailPageOffers required-field check.
export function makeAssembleOffer(
  runner: ScrapePipelineRunnerService,
): OpHandler<AssembleOfferOp> {
  return async (ctx, input, op) => {
    const sellerName = (await runner.run(op.sellerName, ctx, input)) as
      | string
      | undefined;

    const rawPrice = await runner.run(op.price, ctx, input);
    const price = toFiniteNumber(rawPrice);
    if (!sellerName || !Number.isFinite(price)) return undefined;

    const priceWithoutDiscount = op.priceWithoutDiscount
      ? toFiniteNumber(await runner.run(op.priceWithoutDiscount, ctx, input))
      : undefined;

    const currency = op.currency
      ? ((await runner.run(op.currency, ctx, input)) as string | undefined)
      : undefined;

    const availability = op.availability
      ? ((await runner.run(op.availability, ctx, input)) as
          | string
          | undefined)
      : undefined;

    const url = op.url
      ? ((await runner.run(op.url, ctx, input)) as string | undefined)
      : undefined;

    const externalId = op.externalId
      ? ((await runner.run(op.externalId, ctx, input)) as string | undefined)
      : undefined;

    let locations: string[] | undefined;
    if (op.locations) {
      const rawLocations = (await runner.run(op.locations, ctx, input)) as
        | string[]
        | undefined;
      locations = rawLocations && rawLocations.length > 0 ? rawLocations : undefined;
    }

    let specs: ProductSpecs | undefined;
    if (op.specs) {
      specs = {};
      for (const [key, pipeline] of Object.entries(op.specs)) {
        const value = (await runner.run(pipeline, ctx, input)) as
          | ProductSpecs[string]
          | undefined;
        if (value !== undefined) specs[key] = value;
      }
    }

    const record: RawOfferRecord = {
      sellerName,
      price,
      priceWithoutDiscount,
      currency,
      availability,
      url,
      externalId,
      locations,
      specs,
    };

    return record;
  };
}
