import { getMetadataArgsStorage } from 'typeorm';
import ms from 'ms';
import { DEFAULT_DETAIL_REFRESH_INTERVAL, ProductSource } from './product-source.entity';

// The schema is synchronized from the entities (no migrations), so the column
// options are what every existing and new row gets.
const column = (propertyName: keyof ProductSource) =>
  getMetadataArgsStorage().columns.find(
    (candidate) => candidate.target === ProductSource && candidate.propertyName === propertyName,
  );

describe('ProductSource.detailRefreshInterval', () => {
  it('defaults to 60 days on every source that never set it', () => {
    expect(column('detailRefreshInterval')?.options).toMatchObject({
      type: 'text',
      nullable: false,
      default: DEFAULT_DETAIL_REFRESH_INTERVAL,
    });
    expect(ms(DEFAULT_DETAIL_REFRESH_INTERVAL)).toBe(ms('60d'));
  });
});

describe('ProductSource.fetchMode', () => {
  // Existing rows included: a shop is only ever called directly on purpose.
  it('defaults to proxied on every source that never set it', () => {
    expect(column('fetchMode')?.options).toMatchObject({
      type: 'text',
      nullable: false,
      default: 'proxied',
    });
  });
});
