import { Test, TestingModule } from '@nestjs/testing';
import { ProductNormalizerService } from './product-normalizer.service';

describe('ProductNormalizerService', () => {
  let service: ProductNormalizerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductNormalizerService],
    }).compile();

    service = module.get<ProductNormalizerService>(ProductNormalizerService);
  });

  const run = (brand: string, model: string, displayName?: string) =>
    service.normalizeProduct({
      brand,
      model,
      displayName: displayName ?? `${brand} ${model}`,
    });

  it('preserves series-prefixed model code: AOC CU34G4', () => {
    expect(run('AOC', 'CU34G4')).toBe('cu34g4');
  });

  it('drops AGON PRO marketing line: AOC AGON PRO AG346UCD', () => {
    expect(run('AOC', 'AGON PRO AG346UCD')).toBe('ag346ucd');
  });

  it('keeps full model "34GN850" across UltraGear marketing', () => {
    expect(run('LG', '34GN850', 'LG UltraGear 34GN850')).toBe('34gn850');
  });

  it('preserves single-letter variant suffix: 34GN850P-B', () => {
    expect(run('LG', '34GN850P-B', 'LG UltraWide UltraGear 34GN850P-B')).toBe(
      '34gn850pb',
    );
  });

  it('produces distinct keys for color/finish variants', () => {
    const black = run('LG', '39GS95QE-B', 'LG UltraGear 39GS95QE-B');
    const white = run('LG', '39GS95QE-W', 'LG 39GS95QE-W');
    expect(black).toBe('39gs95qeb');
    expect(white).toBe('39gs95qew');
    expect(black).not.toBe(white);
  });

  it('preserves hyphen-tied vendor SKU tail: XB271HU-bmiprz', () => {
    expect(run('Acer', 'XB271HU-bmiprz')).toBe('xb271hubmiprz');
  });

  it('produces same key for OLED and non-OLED variants of the same product', () => {
    const withoutOled = run('ASUS', 'ROG Swift PG32UCDP');
    const withOled = run('ASUS', 'ROG Swift OLED PG32UCDP');
    expect(withoutOled).toBe('pg32ucdp');
    expect(withOled).toBe('pg32ucdp');
  });

  it('keeps series prefix when fused with digits in source: MPG341CQPX', () => {
    expect(run('MSI', 'MPG341CQPX')).toBe('mpg341cqpx');
  });

  it('drops separated series prefix: MSI MPG 341CQPX', () => {
    expect(run('MSI', 'MPG 341CQPX')).toBe('341cqpx');
  });

  it('preserves whitespace between distinct digit-bearing identifiers', () => {
    expect(run('Samsung', 'Odyssey G5 C34G55TWWP')).toBe('g5 c34g55twwp');
  });

  it('falls back to longest alpha chunk when no digits present', () => {
    const result = service.normalizeProduct({
      brand: 'Brand',
      model: 'Some ProductName',
      displayName: 'Brand Some ProductName',
    });
    expect(result).toBe('productname');
  });

  it('falls back to displayName when model is missing', () => {
    const result = service.normalizeProduct({
      brand: 'LG',
      model: undefined,
      displayName: 'LG UltraGear 34GN850',
    });
    expect(result).toBe('34gn850');
  });

  it('throws when both model and displayName are missing', () => {
    expect(() =>
      service.normalizeProduct({
        brand: 'LG',
        model: undefined,
        displayName: undefined,
      }),
    ).toThrow();
  });

  describe("strategy: 'full'", () => {
    const runFull = (brand: string, model: string, displayName?: string) =>
      service.normalizeProduct({
        brand,
        model,
        displayName: displayName ?? `${brand} ${model}`,
        strategy: 'full',
      });

    it('strips the brand prefix', () => {
      expect(runFull('KTM', 'MACINA SCARP SX PRESTIGE Di2')).toBe(
        'macina scarp sx prestige di2',
      );
    });

    it('lowercases and collapses internal whitespace', () => {
      expect(
        runFull('KTM', 'MACINA  SCARP   SX PRESTIGE Di2'),
      ).toBe('macina scarp sx prestige di2');
    });

    it('does not strip punctuation', () => {
      expect(runFull('LG', '34GN850P-B')).toBe('34gn850p-b');
    });

    it('produces distinct keys for different trims of the same model line', () => {
      const prestige = runFull('KTM', 'MACINA SCARP SX PRESTIGE Di2');
      const master = runFull('KTM', 'MACINA SCARP SX MASTER Di2');
      expect(prestige).toBe('macina scarp sx prestige di2');
      expect(master).toBe('macina scarp sx master di2');
      expect(prestige).not.toBe(master);
    });

    it('does not fall back to the digit-heuristic word-dropping behavior', () => {
      // Under 'digit-heuristic' this would collapse to just "di2" (see the
      // top-level describe block) — 'full' must keep the whole model line.
      expect(runFull('KTM', 'MACINA SCARP SX PRESTIGE Di2')).not.toBe('di2');
    });
  });
});
