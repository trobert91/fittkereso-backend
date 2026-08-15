import {
  ExtractAttrListOp,
  ExtractImageWithFallbackOp,
} from '@fittkereso-backend/database';
import { CheerioSelection } from '../interfaces/scrape-execution-context.interface';
import { OpHandler } from '../services/scrape-op-registry.service';

export const extractAttrList: OpHandler<ExtractAttrListOp> = (
  ctx,
  input,
  op,
) => {
  const selection = input as CheerioSelection;
  const urls: string[] = [];
  selection.each((_i, el) => {
    const value = ctx.$(el).attr(op.attr);
    if (value) urls.push(op.trim === false ? value : value.trim());
  });
  return urls;
};

export const extractImageWithFallback: OpHandler<
  ExtractImageWithFallbackOp
> = (ctx, input, op) => {
  const boxes = input as CheerioSelection;
  const urls: string[] = [];

  boxes.each((_i, el) => {
    const $box = ctx.$(el);

    const primaryValue = $box.find(op.primary.selector).attr(op.primary.attr);
    if (
      primaryValue &&
      (!op.primary.mustContain || primaryValue.includes(op.primary.mustContain))
    ) {
      urls.push(primaryValue.trim());
      return;
    }

    let fallbackValue = $box.find(op.fallback.selector).attr(op.fallback.attr);
    if (
      fallbackValue &&
      (!op.fallback.mustContain || fallbackValue.includes(op.fallback.mustContain))
    ) {
      for (const { from, to } of op.fallback.replacePatterns ?? []) {
        fallbackValue = fallbackValue.split(from).join(to);
      }
      urls.push(fallbackValue.trim());
    }
  });

  return urls;
};
