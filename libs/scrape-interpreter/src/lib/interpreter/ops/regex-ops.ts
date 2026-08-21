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
  if (op.cast === 'jsonString') {
    return unescapeJsonString(trimmed);
  }
  return trimmed;
};

// Decodes JSON string escapes (\uXXXX, \/, \", \\, \n, etc.) in a substring
// captured out of a larger JS/JSON text — e.g. a name extracted via regex
// from inside `<script>ShopRenter.product = {"name":"..."}</script>`, which
// otherwise keeps its literal source escaping instead of the real characters.
// Wrapping in quotes and running it through JSON.parse reuses the JSON spec's
// own escape decoding rather than reimplementing it.
function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/(?<!\\)"/g, '\\"')}"`);
  } catch {
    return value;
  }
}

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
