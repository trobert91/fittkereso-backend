import {
  AppendSuffixOp,
  CoalesceOp,
  IdentityOp,
  LiteralOp,
  SplitAndSliceOp,
  SplitAndTakeOp,
  StripPatternOp,
  StripPrefixOp,
  TrimEndOp,
  TrimOp,
} from '@fittkereso-backend/database';
import { OpHandler } from '../services/scrape-op-registry.service';
import { interpolate } from '../services/interpolation.util';

function resolveValue(
  ctx: Parameters<OpHandler>[0],
  input: unknown,
  valueKey?: string,
): string | undefined {
  const raw = valueKey !== undefined ? ctx.vars[valueKey] : input;
  return typeof raw === 'string' ? raw : undefined;
}

export const trim: OpHandler<TrimOp> = (_ctx, input) => {
  return typeof input === 'string' ? input.trim() : input;
};

export const trimEnd: OpHandler<TrimEndOp> = (_ctx, input, op) => {
  const value = typeof input === 'string' ? input : '';
  let end = value.length;
  while (end > 0 && op.chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
};

export const appendSuffix: OpHandler<AppendSuffixOp> = (_ctx, input, op) => {
  const value = typeof input === 'string' ? input : '';
  return value + op.value;
};

export const stripPattern: OpHandler<StripPatternOp> = (ctx, input, op) => {
  const value = resolveValue(ctx, input, op.value);
  if (value === undefined) return undefined;
  const pattern = interpolate(op.pattern, ctx);
  const regex = new RegExp(pattern, op.flags);
  const result = value.replace(regex, '');
  return op.trim === false ? result : result.trim();
};

export const stripPrefix: OpHandler<StripPrefixOp> = (ctx, input, op) => {
  const value = resolveValue(ctx, input, op.value);
  if (value === undefined) return undefined;
  const prefix = interpolate(op.prefix, ctx);
  const regex = new RegExp(`^${escapeRegExp(prefix)}\\s*`, op.flags);
  return value.replace(regex, '');
};

export const splitAndTake: OpHandler<SplitAndTakeOp> = (ctx, input, op) => {
  const value = resolveValue(ctx, input, op.value);
  if (value === undefined) return undefined;
  const part = value.split(op.separator)[op.index];
  if (part === undefined) return undefined;
  return op.trim === false ? part : part.trim();
};

export const splitAndSlice: OpHandler<SplitAndSliceOp> = (ctx, input, op) => {
  const value = resolveValue(ctx, input, op.value);
  if (value === undefined) return undefined;
  const parts = value.split(op.separator);
  return parts.slice(op.skipFirst ?? 0).join(op.separator);
};

export const coalesce: OpHandler<CoalesceOp> = (ctx, _input, op) => {
  for (const key of op.candidates) {
    const value = ctx.vars[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0) return value;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

export const identity: OpHandler<IdentityOp> = (ctx, input, op) => {
  return op.value !== undefined ? ctx.vars[op.value] : input;
};

export const literal: OpHandler<LiteralOp> = (ctx, _input, op) => {
  return interpolate(op.value, ctx);
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
