import {
  FindScriptContainingOp,
  RegexCaptureOp,
} from '@fittkereso-backend/database';
import { CheerioSelection } from '../interfaces/scrape-execution-context.interface';
import { OpHandler } from '../services/scrape-op-registry.service';
import { interpolate } from '../services/interpolation.util';

export const regexCapture: OpHandler<RegexCaptureOp> = (ctx, input, op) => {
  const value =
    op.value !== undefined ? ctx.vars[op.value] : (input as string | undefined);
  if (typeof value !== 'string') return undefined;

  const pattern = interpolate(op.pattern, ctx);
  const match = value.match(new RegExp(pattern));
  const captured = match?.[op.group];
  if (captured === undefined) return undefined;

  const trimmed = op.trim === false ? captured : captured.trim();
  if (op.cast === 'number') {
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }
  return trimmed;
};

// Scans every <script> tag's contents for one containing `contains` (used for
// Arukereso's dataLayerHG-embedded product JSON) and returns its raw text.
export const findScriptContaining: OpHandler<FindScriptContainingOp> = (
  ctx,
  input,
  op,
) => {
  const scripts = (input as CheerioSelection) ?? ctx.$('script');
  const texts = scripts
    .toArray()
    .map((el) => ctx.$(el).html() ?? '');
  return texts.find((text) => text.includes(op.contains));
};
