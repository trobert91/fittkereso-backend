import { ProductModel, ProductSourceRecord } from '@fittkereso-backend/database';
import { ProductUpdateMapperService } from './product-update-mapper.service';

describe('ProductUpdateMapperService', () => {
  const mapper = new ProductUpdateMapperService(
    {} as never, // categoryRepo
    {} as never, // brandRepo
    {} as never, // productImageRepo
    {} as never, // embeddingService
    {} as never, // productNormalizer
    {} as never, // categoryConfigService
  );

  const listing = {
    id: 'record-arukereso',
    source: { id: 'arukereso' },
    scrapedProduct: { description: '<p>A bolt szövege.</p>' },
  } as unknown as ProductSourceRecord;
  const product = (...records: Partial<ProductSourceRecord>[]) =>
    ({ id: 'product-1', description: null, sources: [listing, ...records] }) as unknown as ProductModel;
  const adminRecords = (model: ProductModel) => model.sources.filter((record) => !record.source);

  it("writes the description to the admin's record, next to its specs", async () => {
    const lastUpdated = new Date('2026-01-01');
    const model = product({ source: null, scrapedProduct: { specs: { weight: 21 } }, lastUpdated });

    await mapper.mapDtoToEntity({ description: '  Az admin szövege.  ' }, model);

    expect(adminRecords(model)).toHaveLength(1);
    expect(adminRecords(model)[0].scrapedProduct).toEqual({
      specs: { weight: 21 },
      description: 'Az admin szövege.',
    });
    // The manual specs' recency, which the spec merge reads, is not the description's.
    expect(adminRecords(model)[0].lastUpdated).toBe(lastUpdated);
    // Recomputed from the records, never written directly.
    expect(model.description).toBeNull();
    expect(listing.scrapedProduct?.description).toBe('<p>A bolt szövege.</p>');
  });

  it("creates the admin's record when there is none", async () => {
    const model = product();

    await mapper.mapDtoToEntity({ description: 'Az admin szövege.' }, model);

    expect(adminRecords(model)).toHaveLength(1);
    expect(adminRecords(model)[0].scrapedProduct).toEqual({ description: 'Az admin szövege.' });
    expect(adminRecords(model)[0].lastUpdated).toBeInstanceOf(Date);
  });

  it('removes the override with an empty description', async () => {
    const model = product({ source: null, scrapedProduct: { specs: { weight: 21 }, description: 'régi' } });

    await mapper.mapDtoToEntity({ description: ' ' }, model);

    expect(adminRecords(model)[0].scrapedProduct).toEqual({ specs: { weight: 21 } });
  });

  it('creates no admin record for an empty description', async () => {
    const model = product();

    await mapper.mapDtoToEntity({ description: '' }, model);

    expect(adminRecords(model)).toHaveLength(0);
  });

  it('keeps the description when manual specs are saved, in the one admin record', async () => {
    const model = product({ source: null, scrapedProduct: { description: 'Az admin szövege.' } });

    await mapper.mapDtoToEntity({ manualSpecs: { weight: 23 } }, model);
    await mapper.mapDtoToEntity({ manualSpecs: { weight: 24 }, description: 'Új szöveg.' }, model);

    expect(adminRecords(model)).toHaveLength(1);
    expect(adminRecords(model)[0].scrapedProduct).toEqual({
      specs: { weight: 24 },
      description: 'Új szöveg.',
    });
  });
});
