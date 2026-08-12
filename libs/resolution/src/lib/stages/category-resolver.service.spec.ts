import type { CategoryNameMatcherService } from '@fittkereso-backend/product';
import type { ProductCategory } from '@fittkereso-backend/database';
import { CategoryResolverService } from './category-resolver.service';
import { makeTestContext } from '../testing/make-context';

function makeMatcher(
  result?: Pick<ProductCategory, 'id' | 'name'> | undefined,
  throwError = false,
): CategoryNameMatcherService {
  return {
    matchFromEnabledCategories: jest.fn().mockImplementation(async () => {
      if (throwError) throw new Error('boom');
      return result;
    }),
  } as unknown as CategoryNameMatcherService;
}

describe('CategoryResolverService', () => {
  it('passes through input.category.id directly when set', async () => {
    const matcher = makeMatcher();
    const service = new CategoryResolverService(matcher);

    const context = makeTestContext({
      input: { category: { id: 'cat-monitors', name: 'monitor' } },
    });
    await service.resolve(context);

    expect(matcher.matchFromEnabledCategories).not.toHaveBeenCalled();
    expect(context.category).toEqual({
      id: 'cat-monitors',
      name: 'monitor',
      similarity: 1.0,
    });
  });

  it('falls back to name matching when only category.name is set', async () => {
    const matcher = makeMatcher({
      id: 'cat-1',
      name: 'Monitor',
    } as ProductCategory);
    const service = new CategoryResolverService(matcher);

    const context = makeTestContext({
      input: { category: { name: 'monitor' } },
    });
    await service.resolve(context);

    expect(matcher.matchFromEnabledCategories).toHaveBeenCalledWith('monitor');
    expect(context.category).toEqual({
      id: 'cat-1',
      name: 'Monitor',
      similarity: 1.0,
    });
  });

  it('falls back to categoryHint when input.category is absent', async () => {
    const matcher = makeMatcher({
      id: 'cat-1',
      name: 'Monitor',
    } as ProductCategory);
    const service = new CategoryResolverService(matcher);

    const context = makeTestContext({
      input: { categoryHint: 'gaming monitor' },
    });
    await service.resolve(context);

    expect(matcher.matchFromEnabledCategories).toHaveBeenCalledWith(
      'gaming monitor',
    );
    expect(context.category?.id).toBe('cat-1');
  });

  it('skips when ctx.category is already set (Stage 1 path)', async () => {
    const matcher = makeMatcher();
    const service = new CategoryResolverService(matcher);

    const context = makeTestContext({
      input: { category: { name: 'monitor' } },
      category: { id: 'pre', name: 'PreCat', similarity: 1.0 },
    });
    await service.resolve(context);

    expect(matcher.matchFromEnabledCategories).not.toHaveBeenCalled();
    expect(context.category?.id).toBe('pre');
  });

  it('no-op when no hint is available', async () => {
    const matcher = makeMatcher();
    const service = new CategoryResolverService(matcher);

    const context = makeTestContext({ input: {} });
    await service.resolve(context);

    expect(matcher.matchFromEnabledCategories).not.toHaveBeenCalled();
    expect(context.category).toBeUndefined();
  });

  it('records phase error when matching throws', async () => {
    const matcher = makeMatcher(undefined, true);
    const service = new CategoryResolverService(matcher);

    const context = makeTestContext({
      input: { category: { name: 'monitor' } },
    });
    await service.resolve(context);

    expect(context.category).toBeUndefined();
    expect(context.errors).toHaveLength(1);
    expect(context.errors[0].phase).toBe('category_resolution');
  });
});
