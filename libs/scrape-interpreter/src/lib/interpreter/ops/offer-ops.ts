import { AssembleOfferOp, ProductSpecs } from '@fittkereso-backend/database';
import { OpHandler } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { RawOfferRecord } from '../scrape-interpreter.service';

// A barcode or article number read from JSON can arrive as a number; either
// way it is kept as text, because leading zeros are part of the identifier.
function toIdentifierText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

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
// price doesn't resolve, mirroring the previous single-offer
// runDetailPageOffers required-field check.
export function makeAssembleOffer(
  runner: ScrapePipelineRunnerService,
): OpHandler<AssembleOfferOp> {
  return async (ctx, input, op) => {
    const rawPrice = await runner.run(op.price, ctx, input);
    const price = toFiniteNumber(rawPrice);
    if (!Number.isFinite(price)) return undefined;

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

    const gtin = op.gtin
      ? toIdentifierText(await runner.run(op.gtin, ctx, input))
      : undefined;

    const mpn = op.mpn
      ? toIdentifierText(await runner.run(op.mpn, ctx, input))
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
      price,
      priceWithoutDiscount,
      currency,
      availability,
      url,
      externalId,
      gtin,
      mpn,
      locations,
      specs,
    };

    return record;
  };
}
