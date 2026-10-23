import { specLabelsReadBy } from './spec-labels-read-by';

describe('specLabelsReadBy', () => {
  const readers = specLabelsReadBy({
    enabled: true,
    specMapping: {
      mappings: [
        { key: 'torque', labels: ['Nyomaték', 'Torque'] },
        { key: 'frameSize', labels: ['Méret'], sectionTitle: 'Váz' },
      ],
      calculated: [
        { key: 'abs', rule: 'featureSearch', source: 'Fékek', keywords: ['ABS'] },
        { key: 'lighting', rule: 'presentLabels', source: ['Első lámpa', 'Hátsó lámpa'] },
        { key: 'hasTorque', rule: 'presentIfKey', source: 'torque' },
      ],
    },
    identitySpecRows: ['Motor  ', 'Akkumulátor'],
  });

  it('reads a mapping label ignoring case, but not accents', () => {
    expect(readers.readerOf('nyomaték')).toBe('mapped');
    expect(readers.readerOf('TORQUE')).toBe('mapped');
    expect(readers.readerOf('Nyomatek')).toBe('unread');
  });

  it('reads a sectioned mapping label only within its section', () => {
    expect(readers.readerOf('Méret', 'váz')).toBe('mapped');
    expect(readers.readerOf('Méret', 'Kerék')).toBe('unread');
    expect(readers.readerOf('Méret')).toBe('unread');
  });

  it('counts calculated rules that read labels, not presentIfKey, whose source is a key', () => {
    expect(readers.readerOf('Fékek')).toBe('mapped');
    expect(readers.readerOf('hátsó lámpa')).toBe('mapped');
    expect(readers.readerOf('torque')).toBe('mapped');
    expect(readers.readerOf('hasTorque')).toBe('unread');
  });

  it('marks a row only the identity extraction reads, ignoring stray whitespace', () => {
    expect(readers.readerOf(' motor')).toBe('identity');
    expect(readers.readerOf('AKKUMULÁTOR')).toBe('identity');
    expect(readers.readerOf('Kijelző')).toBe('unread');
  });

  it('lists every mapping label with its key', () => {
    expect(readers.mappingLabels).toEqual([
      { key: 'torque', label: 'Nyomaték', sectionTitle: undefined, mappingIndex: 0 },
      { key: 'torque', label: 'Torque', sectionTitle: undefined, mappingIndex: 0 },
      { key: 'frameSize', label: 'Méret', sectionTitle: 'Váz', mappingIndex: 1 },
    ]);
  });

  it('reads nothing for a missing section', () => {
    const none = specLabelsReadBy(undefined);
    expect(none.readerOf('Nyomaték')).toBe('unread');
    expect(none.mappingLabels).toEqual([]);
  });
});
