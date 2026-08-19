import {
  AssertContainsOp,
  DedupeOp,
  FilterByAllowlistOp,
  FilterByAttrAbsentOp,
  FilterByAttrSuffixOp,
  FilterByCategoryYearSuffixOp,
  FilterByNonEmptyOp,
  FilterOutEqualsIgnoreCaseOp,
  IsEmptyConditionOp,
  TakeFirstOp,
} from '@fittkereso-backend/database';
import { CheerioSelection } from '../interfaces/scrape-execution-context.interface';
import { OpHandler } from '../services/scrape-op-registry.service';
import { PipelineHalt } from '../services/pipeline-halt';
import { WebLink } from '@fittkereso-backend/product';

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof (value as CheerioSelection)?.length === 'number') {
    return (value as CheerioSelection).length === 0;
  }
  return false;
}

export const assertContains: OpHandler<AssertContainsOp> = (
  ctx,
  input,
  op,
) => {
  const value =
    op.value !== undefined ? ctx.vars[op.value] : (input as string);
  const contains = typeof value === 'string' && value.includes(op.substring);
  if (!contains) {
    if (op.onFail === 'throw') {
      throw new Error(
        `assertContains: value did not contain "${op.substring}"`,
      );
    }
    throw new PipelineHalt([]);
  }
  return value;
};

export const filterByNonEmpty: OpHandler<FilterByNonEmptyOp> = (
  ctx,
  input,
  op,
) => {
  const value = op.value !== undefined ? ctx.vars[op.value] : input;
  if (isEmptyValue(value)) {
    if (op.onFail === 'throw') {
      throw new Error('filterByNonEmpty: value was empty');
    }
    throw new PipelineHalt([]);
  }
  return value;
};

export const filterByAttrAbsent: OpHandler<FilterByAttrAbsentOp> = (
  ctx,
  input,
  op,
) => {
  const selection = input as CheerioSelection;
  return selection.filter((_i, el) => ctx.$(el).attr(op.attr) !== undefined);
};

export const filterByAttrSuffix: OpHandler<FilterByAttrSuffixOp> = (
  ctx,
  input,
  op,
) => {
  const selection = input as CheerioSelection;
  return selection.filter((_i, el) => {
    const value = ctx.$(el).attr(op.attr);
    return !!value && !value.endsWith(op.excludeSuffix);
  });
};

export const filterByAllowlist: OpHandler<FilterByAllowlistOp> = (
  ctx,
  input,
  op,
) => {
  const links = (input as WebLink[]) ?? [];
  const allowlist = (ctx.opts[op.against] as string[] | undefined) ?? [];
  const normalizedAllowlist = op.caseInsensitive
    ? allowlist.map((t) => t.toLowerCase())
    : allowlist;

  const filtered = links.filter((link) => {
    const title = op.caseInsensitive ? link.title.toLowerCase() : link.title;
    return normalizedAllowlist.includes(title);
  });

  const dedupeBy = op.dedupeBy;
  if (!dedupeBy) return filtered;
  const seen = new Set<string>();
  return filtered.filter((link) => {
    const key = (link as unknown as Record<string, string>)[dedupeBy];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const filterOutEqualsIgnoreCase: OpHandler<
  FilterOutEqualsIgnoreCaseOp
> = (ctx, input, op) => {
  const values = (input as string[]) ?? [];
  const against = ctx.vars[op.against];
  if (typeof against !== 'string') return values;
  return values.filter((v) => v.toLowerCase() !== against.toLowerCase());
};

export const filterByCategoryYearSuffix: OpHandler<
  FilterByCategoryYearSuffixOp
> = (_ctx, input, op) => {
  const links = (input as WebLink[]) ?? [];
  const currentYear = new Date().getFullYear();
  const start = op.includeCurrentYear === false ? 1 : 0;
  const years: number[] = [];
  for (let i = start; i <= op.yearsBack; i++) years.push(currentYear - i);

  return links.filter((link) => {
    const category = link.category;
    if (!category) return false;
    return years.some((year) => category.includes(String(year)));
  });
};

export const dedupe: OpHandler<DedupeOp> = (_ctx, input) => {
  const values = (input as unknown[]) ?? [];
  return Array.from(new Set(values));
};

export const takeFirst: OpHandler<TakeFirstOp> = (_ctx, input, op) => {
  const values = (input as unknown[]) ?? [];
  return values.slice(0, op.count);
};

export const isEmpty: OpHandler<IsEmptyConditionOp> = (ctx, input, op) => {
  const value = op.value !== undefined ? ctx.vars[op.value] : input;
  return isEmptyValue(value);
};
