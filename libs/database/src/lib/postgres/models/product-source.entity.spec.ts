import { getMetadataArgsStorage } from 'typeorm';
import ms from 'ms';
import { DEFAULT_DETAIL_REFRESH_INTERVAL, ProductSource } from './product-source.entity';

// The schema is synchronized from the entities (no migrations), so the column
// options are what every existing and new row gets.
describe('ProductSource.detailRefreshInterval', () => {
  const column = () =>
    getMetadataArgsStorage().columns.find(
      (candidate) =>
        candidate.target === ProductSource && candidate.propertyName === 'detailRefreshInterval',
    );

  it('defaults to 60 days on every source that never set it', () => {
    expect(column()?.options).toMatchObject({
      type: 'text',
      nullable: false,
      default: DEFAULT_DETAIL_REFRESH_INTERVAL,
    });
    expect(ms(DEFAULT_DETAIL_REFRESH_INTERVAL)).toBe(ms('60d'));
  });
});
