import {
  AssembleListProductOp,
  JsonPathOp,
  OfferAvailability,
  ScrapedListProduct,
} from '@fittkereso-backend/database';
import { get } from 'lodash';
import { OpHandler } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';

function toFiniteNumber(value: unknown): number | undefined {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : undefined;
  return Number.isFinite(num) ? num : undefined;
}

function toTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str.length > 0 ? str : undefined;
}

/**
 * Reads a dotted path off the current pipeline value.
 *
 * `path` is optional so the op can also be used purely to cast — `jsonPath`
 * with only a `cast` turns the item itself into a number/string/boolean.
 */
export const jsonPath: OpHandler<JsonPathOp> = (_ctx, input, op) => {
  const value = op.path ? get(input as object, op.path) : input;

  if (value === undefined || value === null) return undefined;

  switch (op.cast) {
    case 'number':
      return toFiniteNumber(value);
    case 'string':
      return toTrimmedString(value);
    case 'boolean':
      // Strings are the common case here (a JSON payload rendered into an
      // attribute), so "false"/"0" must not read as true the way Boolean()
      // would have them.
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized !== '' && normalized !== 'false' && normalized !== '0';
      }
      return Boolean(value);
    default:
      return value;
  }
};

const AVAILABILITY_VALUES = new Set<string>(Object.values(OfferAvailability));

/**
 * Assembles one ScrapedListProduct from per-field sub-pipelines run against the
 * current item — the list-page counterpart to assembleOffer.
 *
 * Returns undefined (dropped by forEachItem's skipEmptyResults) when no URL
 * resolves: without one the item cannot be matched to a stored listing, so it
 * can neither refresh an offer nor be enqueued for a detail scrape.
 */
export function makeAssembleListProduct(
  runner: ScrapePipelineRunnerService,
): OpHandler<AssembleListProductOp> {
  return async (ctx, input, op) => {
    const url = toTrimmedString(await runner.run(op.url, ctx, input));
    if (!url) return undefined;

    const rawAvailability = op.availability
      ? toTrimmedString(await runner.run(op.availability, ctx, input))
      : undefined;

    // An unrecognised availability string is dropped rather than coerced to
    // `unknown`: the refresh path leaves availability untouched when absent,
    // which preserves whatever a detail scrape established, whereas writing
    // `unknown` would actively degrade it.
    const availability =
      rawAvailability && AVAILABILITY_VALUES.has(rawAvailability)
        ? (rawAvailability as OfferAvailability)
        : undefined;

    const record: ScrapedListProduct = {
      url,
      externalId: op.externalId
        ? toTrimmedString(await runner.run(op.externalId, ctx, input))
        : undefined,
      name: op.name
        ? toTrimmedString(await runner.run(op.name, ctx, input))
        : undefined,
      price: op.price
        ? toFiniteNumber(await runner.run(op.price, ctx, input))
        : undefined,
      priceWithoutDiscount: op.priceWithoutDiscount
        ? toFiniteNumber(await runner.run(op.priceWithoutDiscount, ctx, input))
        : undefined,
      currency: op.currency
        ? toTrimmedString(await runner.run(op.currency, ctx, input))
        : undefined,
      availability,
    };

    return record;
  };
}
