import type { SpecDefinitionJsonSchema } from '@fittkereso-backend/database';
import { getVerbatimSpecKeys } from './product-level-specs';

describe('getVerbatimSpecKeys', () => {
  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {
      frameSize: { type: 'number', title: 'Frame size' },
      frameSizeLabel: {
        type: 'string',
        title: 'Frame size label',
        enum: ['S', 'M', 'L'],
      },
      color: { type: 'string', title: 'Color' },
      motorModel: { type: 'string', title: 'Motor model' },
    },
  };

  it('keeps the free-text offer-level keys: a number is parsed, and a fixed list mapped onto', () => {
    expect(
      getVerbatimSpecKeys(schema, ['frameSize', 'frameSizeLabel', 'color']),
    ).toEqual(['color']);
  });

  it('only ever picks from the offer-level keys it is given', () => {
    expect(getVerbatimSpecKeys(schema, ['frameSize'])).toEqual([]);
  });

  it('skips a key the schema does not define', () => {
    expect(getVerbatimSpecKeys(schema, ['finish', 'color'])).toEqual(['color']);
  });
});
