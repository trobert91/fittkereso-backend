import { prependPrefix } from './string-ops';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';

function makeContext(vars: Record<string, unknown> = {}): ScrapeExecutionContext {
  return {
    $: (() => undefined) as any,
    html: '',
    task: {} as any,
    vars,
    runtime: {} as any,
    opts: {},
  };
}

describe('prependPrefix', () => {
  it('prepends the prefix to the current pipeline value', () => {
    const ctx = makeContext();
    const result = prependPrefix(ctx, '25', { op: 'prependPrefix', prefix: '20' });
    expect(result).toBe('2025');
  });

  it('reads from a named vars entry when `value` is given', () => {
    const ctx = makeContext({ modelYear: '26' });
    const result = prependPrefix(ctx, undefined, {
      op: 'prependPrefix',
      value: 'modelYear',
      prefix: '20',
    });
    expect(result).toBe('2026');
  });

  it('supports {{var}} interpolation in the prefix', () => {
    const ctx = makeContext({ decade: '20' });
    const result = prependPrefix(ctx, '25', {
      op: 'prependPrefix',
      prefix: '{{decade}}',
    });
    expect(result).toBe('2025');
  });

  it('returns undefined when the resolved value is not a string', () => {
    const ctx = makeContext();
    const result = prependPrefix(ctx, undefined, { op: 'prependPrefix', prefix: '20' });
    expect(result).toBeUndefined();
  });
});
