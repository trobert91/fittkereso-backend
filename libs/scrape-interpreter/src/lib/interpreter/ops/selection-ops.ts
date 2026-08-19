import {
  SelectAllOp,
  SelectAttrOp,
  SelectFirstOp,
  SelectNestedTextOp,
  SelectSiblingContainerOp,
  SelectTextOp,
} from '@fittkereso-backend/database';
import {
  CheerioSelection,
  ScrapeExecutionContext,
} from '../interfaces/scrape-execution-context.interface';
import { OpHandler } from '../services/scrape-op-registry.service';

function findInScope(
  ctx: ScrapeExecutionContext,
  selector: string,
  within?: string,
): CheerioSelection {
  if (!within) return ctx.$(selector);
  const scoped = ctx.vars[within] as CheerioSelection | undefined;
  return scoped ? scoped.find(selector) : ctx.$(selector);
}

export const selectAll: OpHandler<SelectAllOp> = (ctx, _input, op) => {
  return findInScope(ctx, op.selector, op.within);
};

export const selectFirst: OpHandler<SelectFirstOp> = (ctx, _input, op) => {
  const found = findInScope(ctx, op.selector, op.within).first();
  if (found.length === 0) {
    if (op.onMissing === 'throw') {
      throw new Error(`selectFirst: no element matched selector "${op.selector}"`);
    }
  }
  return found;
};

export const selectText: OpHandler<SelectTextOp> = (ctx, _input, op) => {
  const selection = op.first
    ? ctx.$(op.selector).first()
    : ctx.$(op.selector);
  const text = selection.text();
  return op.trim === false ? text : text.trim();
};

export const selectAttr: OpHandler<SelectAttrOp> = (ctx, _input, op) => {
  const selection = op.first
    ? ctx.$(op.selector).first()
    : ctx.$(op.selector);
  const value = selection.attr(op.attr);
  if (value === undefined) return undefined;
  return op.trim === false ? value : value.trim();
};

export const selectNestedText: OpHandler<SelectNestedTextOp> = (
  ctx,
  input,
  op,
) => {
  const selection = input as CheerioSelection;
  const item = selection.eq(op.index);
  const text = item.find(op.childSelector).text();
  const trimmed = op.trim === false ? text : text.trim();
  return trimmed || op.fallback;
};

export const selectSiblingContainer: OpHandler<SelectSiblingContainerOp> = (
  ctx,
  input,
  op,
) => {
  const header = input as CheerioSelection;
  const container = header
    .nextUntil(op.untilSelector)
    .filter(op.filterSelector);
  return op.first === false ? container : container.first();
};
