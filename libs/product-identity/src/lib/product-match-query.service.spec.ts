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

  it('gives a listing and its stored record the same key, stripping the resolved brand name', () => {
    // The listing's brand string doesn't match the brand's name; its model repeats the brand.
    const listing = listingOf({ brand: 'CUBE Bikes', model: 'Cube Stereo Hybrid 140' });
    const query = service.ofListing(listing, cube);

    expect(query.keys).toEqual(['140 hybrid stereo']);
    expect(query.keys).toEqual([service.normalizedModelOf(listing, cube.name)]);
    expect(query.keyed).toBe(true);
  });

  it('keys "Tour CX830" and "Tour CX 830" alike', () => {
    const glued = service.ofListing(listingOf({ model: 'Macina Tour CX830' }), cube);
    const spaced = service.ofListing(listingOf({ model: 'Macina Tour CX 830' }), cube);

    expect(glued.keys).toEqual(['830 cx macina tour']);
    expect(spaced.keys).toEqual(glued.keys);
  });

  // The identity extraction was off or failed: no model.
  it('searches a listing the extraction did not name by its title, keyed so it attaches nothing', () => {
    const query = service.ofListing(
      listingOf({
        model: undefined,
        displayName: undefined,
        originalName: 'Cube Stereo Hybrid 140 HPC - M méretben',
      }),
      cube,
    );

    expect(query.keys).toEqual(['140 hpc hybrid m meretben stereo']);
    expect(query.keyed).toBe(false);
    expect(query.model).toBe('Cube Stereo Hybrid 140 HPC - M méretben');
  });

  it('scopes a listing by brand and category, and a stored product also by its own id', () => {
    const scope = {
      brandId: 'brand-cube',
      brandName: 'Cube',
      categoryId: 'cat-ebikes',
      categorySlug: 'ebikes',
      model: 'Stereo Hybrid 140',
      specs: { modelYear: 2024 },
    };

    expect(service.ofListing(listingOf({ specs: { modelYear: 2024 } }), cube)).toEqual({
      ...scope,
      keys: ['140 hybrid stereo'],
      keyed: true,
    });
    // The finder loads a stored product's keys from its listings.
    expect(service.ofProduct(productOf({ specs: { modelYear: 2024 } }))).toEqual({
      productId: 'product-1',
      ...scope,
    });
  });

  it("keys a stored product's own model, for when none of its listings has a key", () => {
    expect(service.keyOfName('Cube Stereo Hybrid 140', 'Cube')).toBe('140 hybrid stereo');
    expect(service.keyOfName(undefined, 'Cube')).toBeUndefined();
  });

  it('refuses a product loaded without its brand or category', () => {
    expect(() => service.ofProduct(productOf({ productCategory: undefined }))).toThrow(
      'needs brand and productCategory loaded',
    );
  });

  describe('normalizedModelOf', () => {
    const matchingConfig = {
      offerLevelSpecs: ['frameSizeLabel', 'color'],
      matchingConfig: { model: { excludeSpecs: ['modelYear', 'wheelSize'] } },
    };

    const offerWith = (specs: ProductSpecs) => ({ specs }) as ScrapedOffer;

    beforeEach(() => categoryConfigService.getConfig.mockReturnValue(matchingConfig));

    it('keys on the model with the listing brand stripped', () => {
      const listing = listingOf({ brand: 'Cube', model: 'Cube Stereo Hybrid ONE22 Pro 800' });

      expect(service.normalizedModelOf(listing)).toBe('22 800 hybrid one pro stereo');
    });

    // The shop's brand string need not be the brand's name.
    it('strips the resolved brand name too', () => {
      const listing = listingOf({ brand: 'Cube Bikes', model: 'CUBE Stereo Hybrid 140' });

      expect(service.normalizedModelOf(listing)).toBe('140 hybrid stereo');
      expect(service.normalizedModelOf(listingOf({ brand: 'C.B.', model: 'Cube Stereo' }), 'Cube')).toBe(
        'stereo',
      );
    });

    it('keys "Tour CX830" and "Tour CX 830" alike', () => {
      expect(service.normalizedModelOf(listingOf({ brand: 'KTM', model: 'Macina Tour CX830' }))).toBe(
        service.normalizedModelOf(listingOf({ brand: 'KTM', model: 'Macina Tour CX 830' })),
      );
    });

    it("drops the listing's own values of the excluded specs, from the listing and its offers", () => {
      const listing = listingOf({
        specs: { modelYear: 2026 },
        offers: [offerWith({ wheelSize: 29 }), offerWith({ wheelSize: '27.5' })],
      });

      expect(
        service.normalizedModelOf({ ...listing, model: 'Reaction Hybrid Pro 750 2026 29' }),
      ).toBe('750 hybrid pro reaction');
      expect(
        service.normalizedModelOf({ ...listing, model: 'Reaction Hybrid Pro 750 27.5' }),
      ).toBe('750 hybrid pro reaction');
    });

    // "XL" is KTM's heavy-duty model and a frame size; dropping the listing's
    // size would key Team XL like Team.
    it('keeps a word that only equals an offer-level value', () => {
      const listing = listingOf({
        brand: 'KTM',
        model: 'Macina Team XL',
        offers: [offerWith({ frameSizeLabel: 'XL' })],
      });

      expect(service.normalizedModelOf(listing)).toBe('macina team xl');
    });

    it('is undefined without a model', () => {
      expect(service.normalizedModelOf(listingOf({ model: undefined }))).toBeUndefined();
    });
  });
});
