import { productDisplayName, productDisplayNameSql } from './product-display-name';

describe('productDisplayName', () => {
  it('puts the brand before the model', () => {
    expect(productDisplayName('KTM', 'Macina Tour CX830')).toBe('KTM Macina Tour CX830');
  });

  // A product named from a shop's title, before any listing named it.
  it('keeps a brand the model already starts with once, whatever its case', () => {
    expect(productDisplayName('Cube', 'CUBE Kathmandu Hybrid ONE 800 54cm')).toBe(
      'CUBE Kathmandu Hybrid ONE 800 54cm',
    );
  });

  it('does not take a word that only starts like the brand for it', () => {
    expect(productDisplayName('Liv', 'Livello 3')).toBe('Liv Livello 3');
  });

  it('shows the model alone without a brand', () => {
    expect(productDisplayName(undefined, 'Macina Tour CX830')).toBe('Macina Tour CX830');
  });
});

describe('productDisplayNameSql', () => {
  it('builds the same rule over the two columns', () => {
    const sql = productDisplayNameSql('brand.name', 'product.model');

    expect(sql).toContain("LOWER(LEFT(BTRIM(product.model), LENGTH(BTRIM(brand.name)) + 1)) = LOWER(BTRIM(brand.name)) || ' '");
    expect(sql).toContain("ELSE BTRIM(brand.name) || ' ' || BTRIM(product.model)");
  });
});
