import { selectIdentitySpecRows } from './identity-spec-rows';

describe('selectIdentitySpecRows', () => {
  const table = [
    { name: 'Kerék', values: ['29"'] },
    { name: 'Motor', values: ['Bosch Performance CX'] },
    { name: 'Fékbetét', values: ['Shimano J05A'] },
    { name: '  Első   gumi ', values: ['Schwalbe Nobby Nic 29x2.4'] },
  ];

  it('keeps only the listed rows', () => {
    expect(
      selectIdentitySpecRows(table, ['Motor', 'Kerék']).map((r) => r.name),
    ).toEqual(['Kerék', 'Motor']);
  });

  it('ignores case, the way specMapping labels do', () => {
    expect(selectIdentitySpecRows(table, ['KERÉK']).map((r) => r.name)).toEqual([
      'Kerék',
    ]);
  });

  it('ignores stray and repeated whitespace in the label', () => {
    expect(selectIdentitySpecRows(table, ['Első gumi'])).toHaveLength(1);
  });

  // In Hungarian an accent can be the whole difference between two words.
  it('does not fold accents', () => {
    expect(selectIdentitySpecRows(table, ['Kerek'])).toEqual([]);
  });

  it.each([undefined, []])('sends the whole table when the source lists no rows (%p)', (specRows) => {
    expect(selectIdentitySpecRows(table, specRows)).toBe(table);
  });

  it('returns nothing for a listing without a spec table', () => {
    expect(selectIdentitySpecRows(undefined, ['Motor'])).toEqual([]);
  });
});
