import { mapValue } from './value-map-ops';
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

describe('mapValue', () => {
  it('maps the current pipeline value via the cases table', () => {
    const ctx = makeContext();
    const result = mapValue(ctx, 'Készleten', {
      op: 'mapValue',
      cases: { Készleten: 'in_stock', 'Gyártói készlet': 'preorder' },
      default: 'unknown',
    });
    expect(result).toBe('in_stock');
  });

  it('falls back to the default for an unmatched value', () => {
    const ctx = makeContext();
    const result = mapValue(ctx, 'Something else', {
      op: 'mapValue',
      cases: { Készleten: 'in_stock' },
      default: 'unknown',
    });
    expect(result).toBe('unknown');
  });

  it('reads from a named vars entry when `value` is given', () => {
    const ctx = makeContext({ stockTitle: 'Gyártói készlet' });
    const result = mapValue(ctx, undefined, {
      op: 'mapValue',
      value: 'stockTitle',
      cases: { 'Gyártói készlet': 'preorder' },
      default: 'unknown',
    });
    expect(result).toBe('preorder');
  });

  it('returns the default when the resolved value is not a string', () => {
    const ctx = makeContext();
    const result = mapValue(ctx, undefined, {
      op: 'mapValue',
      cases: { Készleten: 'in_stock' },
      default: 'unknown',
    });
    expect(result).toBe('unknown');
  });
});
