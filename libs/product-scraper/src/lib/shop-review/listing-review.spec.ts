import { ArukeresoSourceConfig, ProductSourceRecord } from '@fittkereso-backend/database';
import { specLabelsReadBy } from '@fittkereso-backend/product';
import { feedFieldsReadBy } from '../arukereso/feed-fields-read-by';
import { listingSpecs, reviewListing } from './listing-review';

describe('listingSpecs', () => {
  it('marks each spec deterministic, LLM-filled or LLM-changed', () => {
    expect(
      listingSpecs(
        { torque: 85, color: 'Fekete', frameSize: '48', gearCount: '' },
        { torque: 85, color: 'fekete ', frameSize: '48 cm', usageType: 'MTB', gearCount: 12 },
      ),
    ).toEqual([
      { key: 'torque', value: 85, origin: 'd' },
      { key: 'color', value: 'fekete ', origin: 'd' },
      { key: 'frameSize', value: '48 cm', origin: 'llm-changed', deterministic: '48' },
      { key: 'usageType', value: 'MTB', origin: 'llm' },
      { key: 'gearCount', value: 12, origin: 'llm' },
    ]);
  });

  it('keeps the deterministic value when the LLM pass did not run', () => {
    expect(listingSpecs({ torque: 85 }, undefined)).toEqual([{ key: 'torque', value: 85, origin: 'd' }]);
  });
});

describe('reviewListing', () => {
  const record = {
    id: 'r1',
    url: 'https://shop.example/ktm-macina',
    externalId: '1260149146',
    specValid: true,
    scrapedProduct: {
      category: { id: 'c1', slug: 'ebikes', name: 'E-bikes' },
      brand: 'KTM',
      originalName: 'KTM Macina Cross 720',
      model: 'Macina Cross 720',
      extractedSpecs: { torque: 85 },
      specs: { torque: 85, usageType: 'Trekking' },
      rawSpecs: [
        { name: 'Nyomaték', values: ['85 Nm'] },
        { name: 'Kijelző', values: ['Bosch Kiox'] },
        { name: 'Váz', sectionTitle: 'Alap', values: ['Alu'] },
      ],
      page: { url: 'https://shop.example/ktm-macina', rawSpecs: [{ name: 'Kijelző', values: ['Bosch Kiox'] }] },
      description: 'Egy nagyon hosszú leírás',
      images: [{ url: 'a', order: 0 }],
      offers: [{ price: 100, gtin: null }],
    },
    product: {
      id: 'p1',
      publicId: 123456789,
      model: 'Macina Cross 720',
      brand: { name: 'KTM' },
      productCategory: { slug: 'ebikes' },
      specs: { torque: 85, usageType: 'Trekking', batteryCapacity: 720 },
    },
  } as unknown as ProductSourceRecord;

  const feedConfig = {
    baseUrl: 'https://shop.example',
    feedUrl: 'https://shop.example/feed.xml',
    mapping: { name: { field: 'name' } },
  } as unknown as ArukeresoSourceConfig;

  const reviewed = reviewListing({
    record,
    readers: specLabelsReadBy({ enabled: true, specMapping: { mappings: [{ key: 'torque', labels: ['Nyomaték'] }] } }),
    schemaKeys: ['torque', 'usageType', 'batteryCapacity', 'color'],
    feedItem: { fields: { name: 'KTM Macina Cross 720', color: 'dew silver', ean: ' ' } },
    feedReaders: feedFieldsReadBy(feedConfig),
    descriptionLimit: 10,
  });

  it('lays out the product: its name, what other sellers filled, and the keys it lacks', () => {
    expect(reviewed.product).toEqual({
      id: 'p1',
      publicId: 123456789,
      name: 'KTM Macina Cross 720',
      category: 'ebikes',
      otherSellers: [{ key: 'batteryCapacity', value: 720 }],
      missingKeys: ['color'],
    });
  });

  it('marks each raw row with its origin and how the config reads it', () => {
    expect(reviewed.rawRows).toEqual([
      { origin: 'own', name: 'Nyomaték', sectionTitle: undefined, values: ['85 Nm'], reader: 'mapped' },
      { origin: 'page', name: 'Kijelző', sectionTitle: undefined, values: ['Bosch Kiox'], reader: 'unread' },
      { origin: 'own', name: 'Váz', sectionTitle: 'Alap', values: ['Alu'], reader: 'unread' },
    ]);
  });

  it('lists the stored feed row\'s non-empty columns with their readers', () => {
    expect(reviewed.feedFields).toEqual([
      { name: 'name', value: 'KTM Macina Cross 720', readers: ['mapping.name'] },
      { name: 'color', value: 'dew silver', readers: [] },
    ]);
  });

  it('cuts the description and counts images and offers', () => {
    expect(reviewed.description).toBe('Egy nagyon…');
    expect(reviewed.descriptionLength).toBe(24);
    expect(reviewed.images).toBe(1);
    expect(reviewed.offers).toHaveLength(1);
    expect(reviewed.title).toBe('KTM Macina Cross 720');
  });
});
