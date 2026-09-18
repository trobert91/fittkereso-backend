import { ProductSourceConfigInvalidError } from '@fittkereso-backend/database';
import { describeTaskError } from './describe-task-error';

describe('describeTaskError', () => {
  // The jsonb `error` column used to receive JSON.stringify(...), i.e. a JSON
  // string scalar rather than an object — which is why readers had to parse it
  // again. Every case must now produce a real object.
  it('returns an object, never a string', () => {
    expect(typeof describeTaskError(new Error('boom'))).toBe('object');
    expect(typeof describeTaskError('boom')).toBe('object');
    expect(typeof describeTaskError({ odd: true })).toBe('object');
  });

  it('keeps an Error message and stack', () => {
    const result = describeTaskError(new Error('boom'));

    expect(result['message']).toBe('boom');
    expect(result['stack']).toEqual(expect.any(String));
  });

  it('gives a non-Error throw a readable message', () => {
    expect(describeTaskError('just a string')['message']).toBe('just a string');
    expect(describeTaskError({ code: 7 })['message']).toBe('{"code":7}');
  });

  it('keeps a config failure structured, with every bad path', () => {
    const error = new ProductSourceConfigInvalidError(
      { id: 'source-1', name: 'speedbike' },
      [{ path: '/listPage/productLinks/0', message: "must have required property 'selector'" }],
    );

    const result = describeTaskError(error);

    expect(result['kind']).toBe('product_source_config_invalid');
    expect(result['sourceId']).toBe('source-1');
    expect(result['sourceName']).toBe('speedbike');
    expect(result['problems']).toEqual([
      { path: '/listPage/productLinks/0', message: "must have required property 'selector'" },
    ]);
    // A stack pointing at the guard that threw says nothing about what to fix.
    expect(result['stack']).toBeUndefined();
  });

  it('names the source and the problem in the message', () => {
    const error = new ProductSourceConfigInvalidError(
      { id: 'source-1', name: 'speedbike' },
      [{ path: '/detailPage/brand', message: 'must be array' }],
    );

    expect(describeTaskError(error)['message']).toContain('speedbike');
    expect(describeTaskError(error)['message']).toContain('/detailPage/brand');
  });
});
