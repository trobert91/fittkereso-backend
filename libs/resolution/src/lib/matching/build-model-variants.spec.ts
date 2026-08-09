import { buildModelVariants } from './build-model-variants';

describe('buildModelVariants', () => {
  it('returns the original model as the first seed', () => {
    const result = buildModelVariants(
      { model: 'MPG341CQPX' },
      { maxModelVariants: 20 },
    );
    expect(result[0]).toEqual({ model: 'MPG341CQPX', source: 'original' });
  });

  it('strips a trailing single-letter suffix', () => {
    const result = buildModelVariants(
      { model: '34GS95QE-B' },
      { maxModelVariants: 20 },
    );
    const sources = result.map((variant) => variant.source);
    expect(sources).toContain('suffix_strip');
    expect(result.find((variant) => variant.source === 'suffix_strip')?.model).toBe('34GS95QE');
  });

  it('collapses letter-digit whitespace via the normalization variant', () => {
    const result = buildModelVariants(
      { model: 'MPG 341CQPX' },
      { maxModelVariants: 20 },
    );
    expect(result.find((variant) => variant.source === 'normalization')?.model).toBe('MPG341CQPX');
  });

  it('strips brand prefix from the model when brand leads', () => {
    const result = buildModelVariants(
      { model: 'LG 34GS95QE' },
      { brandName: 'LG', maxModelVariants: 20 },
    );
    expect(result.find((variant) => variant.source === 'brand_strip')?.model).toBe('34GS95QE');
  });

  it('falls back to referenceModel when input.model is empty', () => {
    const result = buildModelVariants(
      { referenceModel: 'OLED42C5' },
      { maxModelVariants: 20 },
    );
    expect(result).toEqual([{ model: 'OLED42C5', source: 'reference_model' }]);
  });

  it('includes modelClues as identification_clue seeds', () => {
    const result = buildModelVariants(
      { model: 'G8sd', modelClues: ['G85SD', 'G80SD'] },
      { maxModelVariants: 20 },
    );
    const clueModels = result
      .filter((variant) => variant.source === 'identification_clue')
      .map((variant) => variant.model);
    expect(clueModels).toEqual(['G85SD', 'G80SD']);
  });

  it('dedupes variants that normalize to the same key', () => {
    const result = buildModelVariants(
      { model: 'MPG341CQPX', modelClues: ['mpg341cqpx'] },
      { maxModelVariants: 20 },
    );
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('original');
  });

  it('caps output at maxModelVariants', () => {
    const result = buildModelVariants(
      { model: 'A1', modelClues: ['B2', 'C3', 'D4', 'E5'] },
      { maxModelVariants: 3 },
    );
    expect(result).toHaveLength(3);
  });

  it('returns empty array when no model or clues are present', () => {
    const result = buildModelVariants({}, { maxModelVariants: 20 });
    expect(result).toEqual([]);
  });
});
