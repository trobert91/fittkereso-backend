import { ArukeresoSourceConfig, RawSpecLabelRow } from '@fittkereso-backend/database';
import { specLabelsReadBy } from '@fittkereso-backend/product';
import { feedFieldsReadBy } from '../arukereso/feed-fields-read-by';
import {
  feedFieldChanges,
  feedFieldStats,
  reviewSpecLabels,
  staleMappings,
} from './unread-source-data';

const label = (name: string, extra: Partial<RawSpecLabelRow> = {}): RawSpecLabelRow => ({
  sourceId: 's1',
  slug: 'ebikes',
  name,
  sectionTitle: null,
  count: 3,
  pageCount: 0,
  examples: ['x'],
  ...extra,
});

const readers = specLabelsReadBy({
  enabled: true,
  specMapping: {
    mappings: [
      { key: 'torque', labels: ['Nyomaték'] },
      { key: 'frameSize', labels: ['Méret'], sectionTitle: 'Váz' },
      { key: 'chain', labels: ['Lánc'] },
    ],
  },
  identitySpecRows: ['Motor'],
});

describe('reviewSpecLabels', () => {
  it('marks each label mapped, identity-only or unread for its category', () => {
    const reviewed = reviewSpecLabels(
      [label('NYOMATÉK'), label('Motor'), label('Kijelző'), label('Méret', { sectionTitle: 'Váz' })],
      () => readers,
    );
    expect(reviewed.map((row) => [row.name, row.reader])).toEqual([
      ['NYOMATÉK', 'mapped'],
      ['Motor', 'identity'],
      ['Kijelző', 'unread'],
      ['Méret', 'mapped'],
    ]);
  });
});

describe('staleMappings', () => {
  it('names the mapping entries none of whose labels a row of the category carries', () => {
    const stale = staleMappings('ebikes', readers, [
      label('nyomaték'),
      label('Méret', { sectionTitle: 'Kerék' }),
      label('Lánc', { slug: 'bikes' }),
    ]);
    expect(stale).toEqual([
      { slug: 'ebikes', key: 'frameSize', labels: ['Méret'], sectionTitle: 'Váz' },
      { slug: 'ebikes', key: 'chain', labels: ['Lánc'], sectionTitle: undefined },
    ]);
  });

  it('keeps an entry one of whose alternative labels matches', () => {
    const alternatives = specLabelsReadBy({
      enabled: true,
      specMapping: { mappings: [{ key: 'gender', labels: ['Neme', 'Neme:'] }] },
    });
    expect(staleMappings('ebikes', alternatives, [label('Neme:')])).toEqual([]);
  });
});

describe('feedFieldStats and feedFieldChanges', () => {
  const config = {
    baseUrl: 'https://shop.example',
    feedUrl: 'https://shop.example/feed.xml',
    mapping: { name: { field: 'name' }, price: { field: 'price' } },
  } as unknown as ArukeresoSourceConfig;
  const feedReaders = feedFieldsReadBy(config);

  const stats = feedFieldStats(
    [
      { fields: { name: 'KTM Macina', price: '100', color: 'fekete', ean: '' } },
      { fields: { name: 'Cube Reaction', price: '200', color: 'kék' } },
      { fields: { name: 'Cube Stereo', price: '300', color: 'fekete' } },
    ],
    feedReaders,
  );

  it('counts filled rows, keeps distinct examples and names the readers', () => {
    expect(stats).toEqual([
      { name: 'color', filled: 3, examples: ['fekete', 'kék'], readers: [] },
      { name: 'name', filled: 3, examples: ['KTM Macina', 'Cube Reaction', 'Cube Stereo'], readers: ['mapping.name'] },
      { name: 'price', filled: 3, examples: ['100', '200', '300'], readers: ['mapping.price'] },
      { name: 'ean', filled: 0, examples: [], readers: [] },
    ]);
  });

  it('names columns that appeared and vanished between two sets of rows', () => {
    const before = feedFieldStats([{ fields: { name: 'a', mpn: 'X1', ean: '' } }], feedReaders);
    const now = feedFieldStats([{ fields: { name: 'b', ean: '5901234123457' } }], feedReaders);
    expect(feedFieldChanges(before, now)).toEqual({ appeared: ['ean'], vanished: ['mpn'] });
  });
});
