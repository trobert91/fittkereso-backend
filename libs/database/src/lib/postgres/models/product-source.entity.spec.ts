import { getMetadataArgsStorage } from 'typeorm';
import ms from 'ms';
import {
  DETAIL_REFRESH_ONCE,
  FALLBACK_DETAIL_REFRESH_INTERVAL,
  ProductSource,
} from './product-source.entity';

// The schema is synchronized from the entities (no migrations), so the column
// options are what every new row gets.
const column = (propertyName: keyof ProductSource) =>
  getMetadataArgsStorage().columns.find(
    (candidate) => candidate.target === ProductSource && candidate.propertyName === propertyName,
  );

describe('ProductSource.detailRefreshInterval', () => {
  it("defaults to 'once' on every source that never set it", () => {
    expect(column('detailRefreshInterval')?.options).toMatchObject({
      type: 'text',
      nullable: false,
      default: DETAIL_REFRESH_ONCE,
    });
  });

  it('falls back to 60 days for an interval that cannot be read', () => {
    expect(ms(FALLBACK_DETAIL_REFRESH_INTERVAL)).toBe(ms('60d'));
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
