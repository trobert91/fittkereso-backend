import { RoundOp } from '@fittkereso-backend/database';
import { OpHandler } from '../services/scrape-op-registry.service';

/**
 * Round to `decimals` places (default 0). A numeric string is read as a
 * number first. Anything else — a missing value included — resolves to
 * undefined, so rounding never turns "no price" into 0.
 */
export const round: OpHandler<RoundOp> = (_ctx, input, op) => {
  const value =
    typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;

  const factor = 10 ** (op.decimals ?? 0);
  return Math.round(value * factor) / factor;
};
