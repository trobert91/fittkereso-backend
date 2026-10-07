import { Test, TestingModule } from '@nestjs/testing';
import { SpecExtractionService } from './spec-extraction.service';
import { ProductSpecNormalizationService } from './product-spec-normalization.service';
import {
  SourceSpecConfig,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { ScrapedProductSpec } from '../../models/scraped-product';

describe('SpecExtractionService', () => {
  let service: SpecExtractionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SpecExtractionService, ProductSpecNormalizationService],
    }).compile();

    service = module.get(SpecExtractionService);
  });

  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'Test',
    properties: {
      resolution: { type: 'string', title: 'Resolution' },
      aspectRatio: { type: 'string', title: 'Aspect ratio' },
      screenSize: { type: 'number', title: 'Size' },
      pixelDensity: { type: 'string', title: 'Pixel density' },
      refreshRate: { type: 'number', title: 'Refresh rate' },
      brightness: { type: 'number', title: 'Brightness' },
      connections: { type: 'array', title: 'Connections' },
      isCurved: { type: 'boolean', title: 'Curved' },
      freesync: { type: 'boolean', title: 'FreeSync' },
      gsync: { type: 'boolean', title: 'G-Sync' },
      curvature: { type: 'number', title: 'Curvature' },
      threeD: { type: 'boolean', title: '3D' },
      type: { type: 'string', title: 'Type' },
    },
  };

  // ─── replacePatterns ──────────────────────────────────────────────────────

  describe('replacePatterns', () => {
    it('should replace Unicode × with ASCII x for resolution', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Resolution', values: ['2560 × 1440 pixels'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'resolution',
            labels: ['Resolution'],
            extract: 'removeWhitespace',
            trimSuffixes: ['pixels'],
            replacePatterns: [{ from: '×', to: 'x' }],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['resolution']).toBe('2560x1440');
    });

    it('should apply multiple replace patterns in order', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Resolution', values: ['2560 × 1440 píxeles'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'resolution',
            labels: ['Resolution'],
            extract: 'removeWhitespace',
            trimSuffixes: ['píxeles'],
            replacePatterns: [
              { from: '×', to: 'x' },
              { from: 'í', to: 'i' },
            ],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['resolution']).toBe('2560x1440');
    });

    it('should not alter value when replacePatterns is undefined', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Resolution', values: ['2560x1440'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [{ key: 'resolution', labels: ['Resolution'] }],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['resolution']).toBe('2560x1440');
    });
  });

  // ─── valueMap ─────────────────────────────────────────────────────────────

  describe('valueMap', () => {
    it('should short-circuit translation for mapped Hungarian values', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Típus', values: ['Fül mögé helyezhető'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'type',
            labels: ['Típus'],
            valueMap: {
              Fülhallgató: 'In-ear',
              Fejhallgató: 'Over-ear',
              'Fül mögé helyezhető': 'Ear-hook',
            },
          },
        ],
      };
      const translator = jest.fn((text: string | undefined) => text);

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
        translator,
      });

      expect(result['type']).toBe('Ear-hook');
      expect(translator).not.toHaveBeenCalled();
    });

    it('should be case-insensitive on valueMap keys', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Típus', values: ['fülhallgató'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'type',
            labels: ['Típus'],
            valueMap: { Fülhallgató: 'In-ear' },
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['type']).toBe('In-ear');
    });

    it('should fall through to translator when raw value is not in valueMap', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Típus', values: ['Valami új típus'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'type',
            labels: ['Típus'],
            valueMap: { Fülhallgató: 'In-ear' },
          },
        ],
      };
      const translator = jest.fn(() => 'Some new type');

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
        translator,
      });

      expect(result['type']).toBe('Some new type');
      expect(translator).toHaveBeenCalledWith('Valami új típus');
    });

    it('keeps the source words of an untranslated key while translating the rest', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Típus', values: ['Valami új típus'] },
        { name: 'Felbontás', values: ['Fekete Gyöngyház'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'type', labels: ['Típus'] },
          { key: 'resolution', labels: ['Felbontás'] },
        ],
      };
      const translator = jest.fn(() => 'Translated');

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
        translator,
        untranslatedKeys: ['resolution'],
      });

      expect(result['type']).toBe('Translated');
      expect(result['resolution']).toBe('Fekete Gyöngyház');
      expect(translator).not.toHaveBeenCalledWith('Fekete Gyöngyház');
    });

    it('should not apply valueMap when mapping does not define one', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Típus', values: ['Fülhallgató'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [{ key: 'type', labels: ['Típus'] }],
      };
      const translator = jest.fn(() => 'earbuds');

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
        translator,
      });

      expect(result['type']).toBe('earbuds');
      expect(translator).toHaveBeenCalledWith('Fülhallgató');
    });
  });

  // ─── preferredValueIndex ──────────────────────────────────────────────────

  describe('preferredValueIndex', () => {
    it('should select value at preferred index when available', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Aspect ratio', values: ['1.778:1', '16:9'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'aspectRatio',
            labels: ['Aspect ratio'],
            preferredValueIndex: 1,
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['aspectRatio']).toBe('16:9');
    });

    it('should fall back to index 0 when preferred index is out of bounds', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Aspect ratio', values: ['2.389:1'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'aspectRatio',
            labels: ['Aspect ratio'],
            preferredValueIndex: 1,
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['aspectRatio']).toBe('2.389:1');
    });

    it('should default to index 0 when preferredValueIndex is not set', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Aspect ratio', values: ['1.778:1', '16:9'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [{ key: 'aspectRatio', labels: ['Aspect ratio'] }],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['aspectRatio']).toBe('1.778:1');
    });
  });

  // ─── Extract modes ────────────────────────────────────────────────────────

  describe('extract modes', () => {
    it('number: should extract first number from string', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Pixel density', values: ['110 ppi (pixels per inch)'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'pixelDensity', labels: ['Pixel density'], extract: 'number' },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['pixelDensity']).toBe('110');
    });

    it('secondNumber: should extract second number from string', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Refresh rate', values: ['48 Hz - 280 Hz'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'refreshRate',
            labels: ['Refresh rate'],
            extract: 'secondNumber',
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['refreshRate']).toBe(280);
    });

    it('ceiledNumber: should ceil the extracted number', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Curvature', values: ['1800 mm'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'curvature', labels: ['Curvature'], extract: 'ceiledNumber' },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['curvature']).toBe(1800);
    });

    it('list: should return all br-separated values as array', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        {
          name: 'Connectivity',
          values: [
            '1 x USB 3.2 (Type-B; upstream)',
            '2 x HDMI 2.1',
            '1 x DisplayPort 1.4',
          ],
        },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'connections', labels: ['Connectivity'], extract: 'list' },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['connections']).toEqual([
        '1 x USB 3.2 (Type-B; upstream)',
        '2 x HDMI 2.1',
        '1 x DisplayPort 1.4',
      ]);
    });

    it('list: should split a single comma-separated value into an array', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        {
          name: 'Connectivity',
          values: ['HDMI, USB, Bluetooth'],
        },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'connections', labels: ['Connectivity'], extract: 'list' },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['connections']).toEqual(['HDMI', 'USB', 'Bluetooth']);
    });

    it('removeWhitespace: should strip all whitespace', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Resolution', values: ['1920 x 1080'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'resolution',
            labels: ['Resolution'],
            extract: 'removeWhitespace',
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['resolution']).toBe('1920x1080');
    });
  });

  // ─── Calculated specs ─────────────────────────────────────────────────────

  describe('calculated specs', () => {
    it('featureSearch: should find keyword in feature values', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        {
          name: 'Features',
          values: [
            'AMD FreeSync Premium Pro',
            'NVIDIA G-Sync Compatible',
            'Flicker-free technology',
          ],
        },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [],
        calculated: [
          {
            key: 'freesync',
            rule: 'featureSearch',
            source: 'Features',
            keywords: ['freesync'],
          },
          {
            key: 'gsync',
            rule: 'featureSearch',
            source: 'Features',
            keywords: ['g-sync', 'gsync'],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['freesync']).toBe(true);
      expect(result['gsync']).toBe(true);
    });

    it('featureSearch: should return false when keyword not found', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        {
          name: 'Features',
          values: ['Flicker-free technology', 'Low Blue Light'],
        },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [],
        calculated: [
          {
            key: 'freesync',
            rule: 'featureSearch',
            source: 'Features',
            keywords: ['freesync'],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['freesync']).toBe(false);
    });

    it('presentIfKey: should return true when source key was mapped', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Curvature', values: ['1800 mm'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'curvature', labels: ['Curvature'], extract: 'ceiledNumber' },
        ],
        calculated: [
          { key: 'isCurved', rule: 'presentIfKey', source: 'curvature' },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['isCurved']).toBe(true);
      expect(result['curvature']).toBe(1800);
    });

    it('presentIfKey: should return false when source key was not mapped', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Resolution', values: ['2560x1440'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [{ key: 'resolution', labels: ['Resolution'] }],
        calculated: [
          { key: 'isCurved', rule: 'presentIfKey', source: 'curvature' },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['isCurved']).toBe(false);
    });
  });

  // ─── regexpList ───────────────────────────────────────────────────────────

  describe('regexpList', () => {
    const dimensionSchema: SpecDefinitionJsonSchema = {
      type: 'object',
      title: 'Test',
      properties: {
        widthWithStand: {
          type: 'array',
          title: 'Width (with stand)',
        },
      },
    };

    it('should extract cm and inch values with rounding', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        {
          name: 'Width with stand',
          values: [
            '≈ 1842 mm (millimeters)',
            '≈ 184.2 cm (centimeters)',
            '≈ 72.5197 in (inches)',
            '≈ 6.0433 ft (feet)',
          ],
        },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'widthWithStand',
            labels: ['Width with stand'],
            extract: 'regexpList',
            extractPatterns: ['([\\d.]+)\\s*(cm)', '([\\d.]+)\\s*(in)'],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema: dimensionSchema,
        sourceConfig,
      });

      expect(result['widthWithStand']).toEqual(['184.2 cm', '72.52 in']);
    });

    it('should return undefined when no patterns match', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        {
          name: 'Width with stand',
          values: ['≈ 1842 mm (millimeters)'],
        },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'widthWithStand',
            labels: ['Width with stand'],
            extract: 'regexpList',
            extractPatterns: ['([\\d.]+)\\s*(cm)', '([\\d.]+)\\s*(in)'],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema: dimensionSchema,
        sourceConfig,
      });

      expect(result['widthWithStand']).toBeUndefined();
    });

    it('should return partial matches when only some patterns match', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        {
          name: 'Width with stand',
          values: ['≈ 184.2 cm (centimeters)', '≈ 6.0433 ft (feet)'],
        },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'widthWithStand',
            labels: ['Width with stand'],
            extract: 'regexpList',
            extractPatterns: ['([\\d.]+)\\s*(cm)', '([\\d.]+)\\s*(in)'],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema: dimensionSchema,
        sourceConfig,
      });

      expect(result['widthWithStand']).toEqual(['184.2 cm']);
    });

    it.each([
      ['Schwalbe Land Cruiser, Active, 50-622', '(\\d{2}-\\d{3})', '50-622'],
      ['118  - 136 cm (átlépési magasság : 52 - 63 cm)', '^(\\d{2,3}\\s*-\\s*\\d{2,3}\\s*cm)', '118  - 136 cm'],
      ['Maxxis Rekon 29x2.4", EXO', '(\\d{2}x\\d\\.\\d)', '29x2.4'],
      ['Mountain Bike 27,5 Fully', '(\\d{2}(?:[.,]5)?)', '27.5'],
    ])('keeps a size or range from %j whole, not its first number', (raw, pattern, expected) => {
      const result = service.extractSpecs({
        scrapedSpecs: [{ name: 'Gumi', values: [raw] }],
        schema: dimensionSchema,
        sourceConfig: {
          mappings: [{ key: 'widthWithStand', labels: ['Gumi'], extract: 'regexpList', extractPatterns: [pattern] }],
        },
      });

      expect(result['widthWithStand']).toEqual([expected]);
    });
  });

  // ─── cmToInchList ─────────────────────────────────────────────────────────

  describe('cmToInchList', () => {
    const dimensionSchema: SpecDefinitionJsonSchema = {
      type: 'object',
      title: 'Test',
      properties: {
        widthWithStand: {
          type: 'array',
          title: 'Width (with stand)',
        },
      },
    };

    it('should extract cm value and convert to inches', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Szélesség (talppal)', values: ['51.5 cm'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'widthWithStand',
            labels: ['Szélesség (talppal)'],
            extract: 'cmToInchList',
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema: dimensionSchema,
        sourceConfig,
      });

      expect(result['widthWithStand']).toEqual(['51.5 cm', '20.28 in']);
    });

    it('should return undefined when no cm value found', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Szélesség (talppal)', values: ['20 in'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'widthWithStand',
            labels: ['Szélesség (talppal)'],
            extract: 'cmToInchList',
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema: dimensionSchema,
        sourceConfig,
      });

      expect(result['widthWithStand']).toBeUndefined();
    });
  });

  // ─── mmToCmAndInchList ────────────────────────────────────────────────────

  describe('mmToCmAndInchList', () => {
    const dimensionSchema: SpecDefinitionJsonSchema = {
      type: 'object',
      title: 'Test',
      properties: {
        width: { type: 'array', title: 'Width' },
      },
    };

    it('should convert mm to cm and inches', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Szélesség', values: ['118 mm'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'width', labels: ['Szélesség'], extract: 'mmToCmAndInchList' },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema: dimensionSchema,
        sourceConfig,
      });

      expect(result['width']).toEqual(['11.8 cm', '4.65 in']);
    });

    it('should return undefined when no mm value found', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Szélesség', values: ['4.65 in'] },
      ];
      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'width', labels: ['Szélesség'], extract: 'mmToCmAndInchList' },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema: dimensionSchema,
        sourceConfig,
      });

      expect(result['width']).toBeUndefined();
    });
  });

  // ─── End-to-end: DisplaySpecs monitor ─────────────────────────────────────

  describe('end-to-end DisplaySpecs extraction', () => {
    it('should correctly extract LG 27GX700A specs', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Size class', values: ['26.5 in (inches)'] },
        {
          name: 'Resolution',
          values: ['2560 × 1440 pixels', 'Quad HD (QHD) / 1440p'],
        },
        { name: 'Panel Type', values: ['OLED'] },
        {
          name: 'Pixel density',
          values: [
            '110 ppi (pixels per inch)',
            '43 ppcm (pixels per centimeter)',
          ],
        },
        {
          name: 'Brightness',
          values: ['335 cd/m² (candela per square meter)'],
        },
        { name: 'Aspect ratio', values: ['1.778:1', '16:9'] },
        {
          name: 'Vertical frequency (digital)',
          values: ['48 Hz - 280 Hz (hertz)'],
        },
        {
          name: 'Features',
          values: [
            'AMD FreeSync Premium Pro',
            'NVIDIA G-Sync Compatible',
            'Flicker-free technology',
          ],
        },
      ];

      const sourceConfig: SourceSpecConfig = {
        mappings: [
          { key: 'screenSize', labels: ['Size class'] },
          {
            key: 'resolution',
            labels: ['Resolution'],
            extract: 'removeWhitespace',
            trimSuffixes: ['pixels'],
            replacePatterns: [{ from: '×', to: 'x' }],
          },
          { key: 'pixelDensity', labels: ['Pixel density'], extract: 'number' },
          { key: 'brightness', labels: ['Brightness'], extract: 'number' },
          {
            key: 'aspectRatio',
            labels: ['Aspect ratio'],
            preferredValueIndex: 1,
          },
          {
            key: 'refreshRate',
            labels: ['Vertical frequency (digital)'],
            extract: 'secondNumber',
          },
        ],
        calculated: [
          {
            key: 'freesync',
            rule: 'featureSearch',
            source: 'Features',
            keywords: ['freesync'],
          },
          {
            key: 'gsync',
            rule: 'featureSearch',
            source: 'Features',
            keywords: ['g-sync', 'gsync'],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['screenSize']).toBe(26.5);
      expect(result['resolution']).toBe('2560x1440');
      expect(result['pixelDensity']).toBe('110');
      expect(result['brightness']).toBe(335);
      expect(result['aspectRatio']).toBe('16:9');
      expect(result['refreshRate']).toBe(280);
      expect(result['freesync']).toBe(true);
      expect(result['gsync']).toBe(true);
    });

    it('should correctly extract MSI ultrawide specs (single aspect ratio value)', () => {
      const scrapedSpecs: ScrapedProductSpec[] = [
        { name: 'Aspect ratio', values: ['2.389:1'] },
        { name: 'Resolution', values: ['3440 × 1440 pixels'] },
      ];

      const sourceConfig: SourceSpecConfig = {
        mappings: [
          {
            key: 'aspectRatio',
            labels: ['Aspect ratio'],
            preferredValueIndex: 1,
          },
          {
            key: 'resolution',
            labels: ['Resolution'],
            extract: 'removeWhitespace',
            trimSuffixes: ['pixels'],
            replacePatterns: [{ from: '×', to: 'x' }],
          },
        ],
      };

      const result = service.extractSpecs({
        scrapedSpecs,
        schema,
        sourceConfig,
      });

      expect(result['aspectRatio']).toBe('2.389:1');
      expect(result['resolution']).toBe('3440x1440');
    });
  });

  // ─── valuePatterns ────────────────────────────────────────────────────────

  describe('valuePatterns', () => {
    const bikeSchema: SpecDefinitionJsonSchema = {
      type: 'object',
      title: 'Bike',
      properties: {
        frameMaterial: {
          type: 'string',
          title: 'Frame material',
          enum: ['Alumínium', 'Karbon', 'Acél'],
        },
        rack: {
          type: 'string',
          title: 'Rack',
          enum: ['Alapfelszereltség', 'Opcionális', 'Nincs'],
        },
        kickstand: { type: 'boolean', title: 'Kickstand' },
        wheelSize: { type: 'number', title: 'Wheel size' },
      },
    };
    const extract = (name: string, value: string, sourceConfig: SourceSpecConfig) =>
      service.extractSpecs({
        scrapedSpecs: [{ name, values: [value] }],
        schema: bikeSchema,
        sourceConfig,
      });

    const material: SourceSpecConfig = {
      mappings: [
        {
          key: 'frameMaterial',
          labels: ['Váz'],
          valuePatterns: [
            { pattern: 'carbon|karbon|C:6\\d', value: 'Karbon' },
            { pattern: 'alu|alloy', value: 'Alumínium' },
            { pattern: 'hi-?ten|steel|acél|cr-?mo', value: 'Acél' },
          ],
        },
      ],
    };

    it.each([
      ['Aluminium Superlite, Trekking Comfort, Double Butted', 'Alumínium'],
      ['C:62® Advanced Twin Mold Technology', 'Karbon'],
      ['HI-TEN ACÉL/STEEL', 'Acél'],
    ])('reads an enum named in free text: %j → %j', (raw, expected) => {
      expect(extract('Váz', raw, material)).toEqual({ frameMaterial: expected });
    });

    it('gives nothing when no pattern matches, rather than the raw text', () => {
      expect(extract('Váz', 'Titanium Pro', material)).toEqual({});
    });

    it('turns a named component into "present", and "nincs" into none', () => {
      const rack: SourceSpecConfig = {
        mappings: [
          {
            key: 'rack',
            labels: ['Csomagtartó'],
            valuePatterns: [
              { pattern: '^(nincs|-|n/a)$', value: 'Nincs' },
              { pattern: '.', value: 'Alapfelszereltség' },
            ],
          },
          {
            key: 'kickstand',
            labels: ['Kitámasztó'],
            valuePatterns: [{ pattern: '.', value: 'true' }],
          },
        ],
      };
      expect(extract('Csomagtartó', 'ACID SIC 2.1 RILink', rack)).toEqual({
        rack: 'Alapfelszereltség',
      });
      expect(extract('Csomagtartó', 'nincs', rack)).toEqual({ rack: 'Nincs' });
      expect(extract('Kitámasztó', 'ACID FM Pure Kickstand', rack)).toEqual({ kickstand: true });
    });

    it('passes the value through extract', () => {
      const wheel: SourceSpecConfig = {
        mappings: [
          {
            key: 'wheelSize',
            labels: ['Kategória'],
            valuePatterns: [{ pattern: 'Mountain Bike 27,5', value: '27.5' }],
            extract: 'number',
          },
        ],
      };
      expect(extract('Kategória', 'Kerékpár > Mountain Bike > Mountain Bike 27,5 > férfi', wheel)).toEqual({
        wheelSize: 27.5,
      });
    });
  });

  // ─── multiply ─────────────────────────────────────────────────────────────

  describe("extract: 'multiply'", () => {
    const gears: SourceSpecConfig = {
      mappings: [{ key: 'refreshRate', labels: ['Fokozatok'], extract: 'multiply' }],
    };

    it.each([
      ['2X12 SHIMANO GRX', 24],
      ['3x8', 24],
      ['1X11 SHIMANO CUES', 11],
      ['2 × 10', 20],
      ['1*10', 10],
      ['21', 21],
      ['24 gears', 24],
    ])('reads %j as %j', (raw, expected) => {
      expect(
        service.extractSpecs({
          scrapedSpecs: [{ name: 'Fokozatok', values: [raw] }],
          schema,
          sourceConfig: gears,
        }),
      ).toEqual({ refreshRate: expected });
    });

    it('reads no count from a model number further in', () => {
      expect(
        service.extractSpecs({
          scrapedSpecs: [{ name: 'Fokozatok', values: ['SHIMANO 105 DI2'] }],
          schema,
          sourceConfig: gears,
        }),
      ).toEqual({});
    });
  });

  // ─── several mappings for one key ─────────────────────────────────────────

  describe('several mappings for one key', () => {
    const gears: SourceSpecConfig = {
      mappings: [
        {
          key: 'refreshRate',
          labels: ['Hátsó váltó'],
          extract: 'regexpList',
          extractPatterns: ['(\\d{1,2})-Speed'],
        },
        { key: 'refreshRate', labels: ['Hajtásrendszer'], extract: 'multiply' },
      ],
    };
    const extract = (rows: Record<string, string>) =>
      service.extractSpecs({
        scrapedSpecs: Object.entries(rows).map(([name, value]) => ({ name, values: [value] })),
        schema,
        sourceConfig: gears,
      });

    it('lets the later mapping win when it yields a value', () => {
      expect(extract({ 'Hátsó váltó': 'Shimano 105, 12-Speed', Hajtásrendszer: '2X12 SHIMANO 105' })).toEqual({
        refreshRate: 24,
      });
    });

    it("keeps the earlier value when the later mapping's row yields nothing", () => {
      expect(extract({ 'Hátsó váltó': 'Shimano 105, 12-Speed', Hajtásrendszer: 'SHIMANO 105' })).toEqual({
        refreshRate: 12,
      });
    });
  });
});
