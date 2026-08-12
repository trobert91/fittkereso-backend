import { ProductSpecs, StructuredSpec } from '@fittkereso-backend/database';
import {
  computeEffectiveMatchSpecs,
  pickPrimarySpecs,
} from './effective-match-specs';

describe('pickPrimarySpecs', () => {
  it('returns an empty object when specs is undefined', () => {
    expect(pickPrimarySpecs(undefined, ['screenSize'])).toEqual({});
  });

  it('returns an empty object when primarySpecs is undefined', () => {
    expect(pickPrimarySpecs({ screenSize: '34"' }, undefined)).toEqual({});
  });

  it('returns an empty object when primarySpecs is empty', () => {
    expect(pickPrimarySpecs({ screenSize: '34"' }, [])).toEqual({});
  });

  it('keeps only keys listed in primarySpecs', () => {
    const specs: ProductSpecs = {
      screenSize: '34"',
      brightness: '300 nits',
      panelType: 'OLED',
    };
    const result = pickPrimarySpecs(specs, ['screenSize', 'panelType']);
    expect(result).toEqual({ screenSize: '34"', panelType: 'OLED' });
  });

  it('drops nil values even when the key is in primarySpecs', () => {
    const specs: ProductSpecs = {
      screenSize: '34"',
      panelType: undefined,
    };
    const result = pickPrimarySpecs(specs, ['screenSize', 'panelType']);
    expect(result).toEqual({ screenSize: '34"' });
  });
});

describe('computeEffectiveMatchSpecs', () => {
  const PRIMARY = [
    'screenSize',
    'resolution',
    'refreshRate',
    'curvature',
    'panelType',
  ];

  it('returns an empty object when there is no reference and no input', () => {
    expect(computeEffectiveMatchSpecs(undefined, undefined, PRIMARY)).toEqual(
      {},
    );
  });

  it('returns just input.specs ∩ primarySpecs when no reference is set', () => {
    const input: StructuredSpec[] = [
      { name: 'screenSize', value: '39"' },
      { name: 'brightness', value: '300 nits' },
    ];
    const result = computeEffectiveMatchSpecs(undefined, input, PRIMARY);
    expect(result).toEqual({ screenSize: '39"' });
  });

  it('returns reference primary specs when there is no comment override (trigger case)', () => {
    // Trigger case: 34" reference, comment doesn't contradict.
    const reference: ProductSpecs = {
      screenSize: '34"',
      resolution: '3440x1440',
      refreshRate: '240Hz',
      curvature: '800R',
      panelType: 'OLED',
    };
    const result = computeEffectiveMatchSpecs(reference, undefined, PRIMARY);
    expect(result).toEqual({
      screenSize: '34"',
      resolution: '3440x1440',
      refreshRate: '240Hz',
      curvature: '800R',
      panelType: 'OLED',
    });
  });

  it('overlays the comment override per dimension, preserving the rest from the reference', () => {
    // LG 34GS95QE example: comment says "the 39 inch version" → screen size is overridden,
    // resolution / refreshRate / curvature / panelType stay inherited.
    const reference: ProductSpecs = {
      screenSize: '34"',
      resolution: '3440x1440',
      refreshRate: '240Hz',
      curvature: '800R',
      panelType: 'OLED',
    };
    const input: StructuredSpec[] = [{ name: 'screenSize', value: '39"' }];
    const result = computeEffectiveMatchSpecs(reference, input, PRIMARY);
    expect(result).toEqual({
      screenSize: '39"',
      resolution: '3440x1440',
      refreshRate: '240Hz',
      curvature: '800R',
      panelType: 'OLED',
    });
  });

  it('ignores comment overrides on non-primary spec keys', () => {
    const reference: ProductSpecs = { screenSize: '34"' };
    const input: StructuredSpec[] = [
      { name: 'brightness', value: '300 nits' }, // not in primarySpecs
      { name: 'screenSize', value: '39"' },
    ];
    const result = computeEffectiveMatchSpecs(reference, input, PRIMARY);
    expect(result).toEqual({ screenSize: '39"' });
  });

  it('ignores reference specs whose key is not in primarySpecs', () => {
    const reference: ProductSpecs = {
      screenSize: '34"',
      brightness: '300 nits', // not in primarySpecs
    };
    const result = computeEffectiveMatchSpecs(reference, undefined, PRIMARY);
    expect(result).toEqual({ screenSize: '34"' });
  });

  it('returns an empty object when primarySpecs is undefined', () => {
    const reference: ProductSpecs = { screenSize: '34"' };
    const input: StructuredSpec[] = [{ name: 'screenSize', value: '39"' }];
    expect(computeEffectiveMatchSpecs(reference, input, undefined)).toEqual({});
  });
});
