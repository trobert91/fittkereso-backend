import type {
  Brand,
  ProductModel,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { ProductNormalizerService } from '@fittkereso-backend/product';
import { ProductMatchQueryService } from './product-match-query.service';

describe('ProductMatchQueryService', () => {
  const cube = { id: 'brand-cube', name: 'Cube' } as Brand;
  const category = { id: 'cat-ebikes', slug: 'ebikes', name: 'E-bikes' };
  let categoryConfigService: { getConfig: jest.Mock };
  let service: ProductMatchQueryService;

  function listingOf(fields: Partial<ScrapedProduct> = {}): ScrapedProduct {
    return {
      category,
      brand: 'Cube',
      model: 'Stereo Hybrid 140',
      displayName: 'Cube Stereo Hybrid 140',
      ...fields,
    } as ScrapedProduct;
  }

  function productOf(fields: Partial<ProductModel> = {}): ProductModel {
    return {
      id: 'product-1',
      brand: cube,
      productCategory: { id: category.id, slug: category.slug },
      model: 'Stereo Hybrid 140',
      displayName: 'Cube Stereo Hybrid 140',
      ...fields,
    } as ProductModel;
  }

  beforeEach(() => {
    categoryConfigService = { getConfig: jest.fn().mockReturnValue(undefined) };
    service = new ProductMatchQueryService(
      new ProductNormalizerService(),
      categoryConfigService as never,
    );
  });

  it('gives a product and a listing of it the same key, stripping the resolved brand name', () => {
    // The listing's brand string doesn't match the brand's name; its model repeats the brand.
    const listing = service.ofListing(
      listingOf({ brand: 'CUBE Bikes', model: 'Cube Stereo Hybrid 140' }),
      cube,
    );
    const product = service.ofProduct(productOf());

    expect(listing.nameKey).toBe('140 hybrid stereo');
    expect(product.nameKey).toBe(listing.nameKey);
  });

  it('builds the key with the category strategy', () => {
    categoryConfigService.getConfig.mockReturnValue({ normalizationStrategy: 'full' });

    expect(service.ofListing(listingOf(), cube).nameKey).toBe('stereo hybrid 140');
    expect(categoryConfigService.getConfig).toHaveBeenCalledWith('ebikes');
  });

  it('falls back to the display name when there is no model', () => {
    const query = service.ofListing(
      listingOf({ model: undefined, displayName: 'Cube Stereo Hybrid 140 HPC' }),
      cube,
    );

    expect(query.nameKey).toBe('140 hpc hybrid stereo');
  });

  it('scopes a listing by brand and category, and a stored product also by its own id', () => {
    const scope = {
      brandId: 'brand-cube',
      brandName: 'Cube',
      categoryId: 'cat-ebikes',
      categorySlug: 'ebikes',
      nameKey: '140 hybrid stereo',
      specs: { modelYear: 2024 },
    };

    expect(service.ofListing(listingOf({ specs: { modelYear: 2024 } }), cube)).toEqual(scope);
    expect(service.ofProduct(productOf({ specs: { modelYear: 2024 } }))).toEqual({
      productId: 'product-1',
      ...scope,
    });
  });

  it('refuses a product loaded without its brand or category', () => {
    expect(() => service.ofProduct(productOf({ productCategory: undefined }))).toThrow(
      'needs brand and productCategory loaded',
    );
  });
});
