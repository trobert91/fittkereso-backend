import { compareSpecValue, SpecValue } from './spec-values';

describe('compareSpecValue', () => {
  describe('numbers', () => {
    it.each<[SpecValue, SpecValue]>([
      ['27', 27],
      ['240', 244],
      ['240Hz', 240],
      ['240Hz', '240 Hz'],
      [240, 244],
    ])('matches %p and %p', (a, b) => {
      expect(compareSpecValue(a, b)).toBe('match');
    });

    it.each<[SpecValue, SpecValue]>([
      ['240', 144],
      // One edit apart, but two different numbers.
      ['39', '34'],
    ])('rejects %p and %p', (a, b) => {
      expect(compareSpecValue(a, b)).toBe('mismatch');
    });
  });

  describe('per-spec tolerance', () => {
    it('treats adjacent model years as a mismatch under absolute: 0', () => {
      expect(compareSpecValue(2024, 2025, undefined, { absolute: 0 })).toBe('mismatch');
    });

    it('matches those years on the relative default', () => {
      expect(compareSpecValue(2024, 2025)).toBe('match');
    });

    it('applies the override to a string-typed value too', () => {
      expect(compareSpecValue('2024', 2025, undefined, { absolute: 0 })).toBe('mismatch');
    });

    it('keeps magnitudes on the relative default', () => {
      expect(compareSpecValue(750, 760)).toBe('match');
    });

    it('honours a non-zero absolute tolerance', () => {
      expect(compareSpecValue(2024, 2025, undefined, { absolute: 1 })).toBe('match');
      expect(compareSpecValue(2024, 2026, undefined, { absolute: 1 })).toBe('mismatch');
    });

    it('honours a percent tolerance', () => {
      expect(compareSpecValue(100, 109, undefined, { percent: 10 })).toBe('match');
      expect(compareSpecValue(100, 112, undefined, { percent: 10 })).toBe('mismatch');
    });
  });

  describe('strings', () => {
    it.each<[SpecValue, SpecValue]>([
      ['IPS', 'ips'],
      ['27 inch', '27'],
      ['240Hz', '240'],
      ['Fast IPS', 'fast ips'],
      ['flat', 'flai'],
      ['QD-OLED', 'QD OLED'],
    ])('matches %p and %p', (a, b) => {
      expect(compareSpecValue(a, b)).toBe('match');
    });

    it('rejects different panel types', () => {
      expect(compareSpecValue('IPS', 'VA')).toBe('mismatch');
    });
  });

  describe('booleans', () => {
    it.each<[SpecValue, SpecValue]>([
      [true, true],
      ['true', true],
      ['false', false],
    ])('matches %p and %p', (a, b) => {
      expect(compareSpecValue(a, b)).toBe('match');
    });

    it('rejects different booleans', () => {
      expect(compareSpecValue(true, false)).toBe('mismatch');
    });
  });

  describe('arrays', () => {
    it.each<[string[], string[]]>([
      [['USB-C', 'HDMI'], ['USB-C', 'HDMI']],
      [['HDMI', 'USB-C'], ['USB-C', 'HDMI']],
      [['USB-C'], ['USB-C', 'HDMI', 'DisplayPort']],
      [['USB-C', 'HDMI', 'DisplayPort'], ['HDMI']],
      [['usb-c'], ['USB-C', 'HDMI']],
    ])('matches %p and %p', (a, b) => {
      expect(compareSpecValue(a, b)).toBe('match');
    });

    it('rejects arrays with no subset relationship', () => {
      expect(compareSpecValue(['USB-C', 'Thunderbolt'], ['HDMI', 'DisplayPort'])).toBe('mismatch');
    });
  });

  describe('hierarchy', () => {
    const panelTypes = {
      OLED: ['QD-OLED', 'W-OLED', 'WOLED'],
      LCD: ['IPS', 'VA', 'TN'],
    };

    it.each([
      ['OLED', 'QD-OLED'],
      ['QD-OLED', 'OLED'],
      ['oled', 'qd-oled'],
      ['matte WOLED', 'OLED'],
      ['glossy QD-OLED', 'QD-OLED'],
    ])('treats %p and %p as compatible', (a, b) => {
      expect(compareSpecValue(a, b, panelTypes)).toBe('compatible');
    });

    it.each([
      ['IPS', 'VA'],
      ['QD-OLED', 'IPS'],
      ['matte WOLED', 'IPS'],
    ])('keeps %p and %p a mismatch', (a, b) => {
      expect(compareSpecValue(a, b, panelTypes)).toBe('mismatch');
    });

    it('treats a usage subtype as compatible with its parent', () => {
      const usageTypes = { MTB: ['Összteleszkópos MTB'], Trekking: ['Cross Trekking'] };

      expect(compareSpecValue('Összteleszkópos MTB', 'MTB', usageTypes)).toBe('compatible');
      expect(compareSpecValue('Cross Trekking', 'MTB', usageTypes)).toBe('mismatch');
    });
  });

  describe('mixed types', () => {
    it('rejects a string with no number against a number', () => {
      expect(compareSpecValue('QD-OLED', 240)).toBe('mismatch');
    });
  });
});
