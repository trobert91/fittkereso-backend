import type {
  Brand,
  ProductModel,
  ProductSpecs,
  ScrapedOffer,
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

  // The identity extraction was off or failed: no model, no display name.
  it('keys a listing the extraction did not name on its title', () => {
    const query = service.ofListing(
      listingOf({
        model: undefined,
        displayName: undefined,
        originalName: 'Cube Stereo Hybrid 140 HPC - M méretben',
      }),
      cube,
    );

    expect(query.nameKey).toBe('140 hpc hybrid m méretben stereo');
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

    expect(service.ofListing(listingOf({ specs: { modelYear: 2024 } }), cube)).toEqual({
      ...scope,
      matcherModelKeys: [],
    });
    // The finder loads a stored product's keys.
    expect(service.ofProduct(productOf({ specs: { modelYear: 2024 } }))).toEqual({
      productId: 'product-1',
      ...scope,
    });
  });

  it("carries a listing's matcherModel key, built as its record stores it", () => {
    const listing = listingOf({ matcherModel: 'Stereo Hybrid 140 Pro' });

    expect(service.ofListing(listing, cube).matcherModelKeys).toEqual([
      service.matcherModelKeyOf(listing, 'Stereo Hybrid 140 Pro'),
    ]);
    expect(service.ofListing(listing, cube).matcherModelKeys).toEqual(['140 hybrid pro stereo']);
  });

  it('requires matcherModel keys only where the category says so', () => {
    categoryConfigService.getConfig.mockReturnValue({ matchingConfig: { matcherModel: { required: true } } });
    expect(service.requiresMatcherModel('ebikes')).toBe(true);

    categoryConfigService.getConfig.mockReturnValue({ matchingConfig: { matcherModel: {} } });
    expect(service.requiresMatcherModel('ebikes')).toBe(false);
  });

  it('refuses a product loaded without its brand or category', () => {
    expect(() => service.ofProduct(productOf({ productCategory: undefined }))).toThrow(
      'needs brand and productCategory loaded',
    );
  });

  describe('matcherModelKeyOf', () => {
    const matchingConfig = {
      offerLevelSpecs: ['frameSizeLabel', 'color'],
      matchingConfig: { matcherModel: { excludeSpecs: ['modelYear', 'wheelSize'] } },
    };

    const offerWith = (specs: ProductSpecs) => ({ specs }) as ScrapedOffer;

    beforeEach(() => categoryConfigService.getConfig.mockReturnValue(matchingConfig));

    it('keys on the text with the listing brand stripped', () => {
      const listing = listingOf({ brand: 'Cube' });

      expect(service.matcherModelKeyOf(listing, 'Cube Stereo Hybrid ONE22 Pro 800')).toBe(
        '22 800 hybrid one pro stereo',
      );
    });

    it("drops the listing's own values of the excluded specs, from the listing and its offers", () => {
      const listing = listingOf({
        specs: { modelYear: 2026 },
        offers: [offerWith({ wheelSize: 29 }), offerWith({ wheelSize: '27.5' })],
      });

      expect(service.matcherModelKeyOf(listing, 'Reaction Hybrid Pro 750 2026 29')).toBe(
        '750 hybrid pro reaction',
      );
      expect(service.matcherModelKeyOf(listing, 'Reaction Hybrid Pro 750 27.5')).toBe(
        '750 hybrid pro reaction',
      );
    });

    // "XL" is KTM's heavy-duty model and a frame size; dropping the listing's
    // size would key Team XL like Team.
    it('keeps a word that only equals an offer-level value', () => {
      const listing = listingOf({
        brand: 'KTM',
        offers: [offerWith({ frameSizeLabel: 'XL' })],
      });

      expect(service.matcherModelKeyOf(listing, 'Macina Team XL')).toBe('macina team xl');
    });

    it('is undefined without text', () => {
      expect(service.matcherModelKeyOf(listingOf(), undefined)).toBeUndefined();
    });

    it('lists the offer-level and the configured specs as left out', () => {
      expect(service.excludedSpecKeysOf('ebikes')).toEqual([
        'frameSizeLabel',
        'color',
        'modelYear',
        'wheelSize',
      ]);
    });
  });
});
