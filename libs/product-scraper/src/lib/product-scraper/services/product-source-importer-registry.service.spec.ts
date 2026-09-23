import {
  PRODUCT_SOURCE_TYPES,
  ProductSourceType,
} from '@fittkereso-backend/database';
import { ProductSourceImporterRegistry } from './product-source-importer-registry.service';
import { ProductSourceImporter } from '../../interfaces/product-source-importer.interface';
import { ProductScraperModule } from '../product-scraper.module';
import { ScrapingImportService } from './scraping-import.service';
import { ArukeresoImportService } from '../../arukereso/arukereso-import.service';

const stubImporter = (type: ProductSourceType): ProductSourceImporter => ({
  type,
  import: jest.fn(),
});

describe('ProductSourceImporterRegistry', () => {
  let registry: ProductSourceImporterRegistry;

  beforeEach(() => {
    registry = new ProductSourceImporterRegistry();
  });

  it('resolves a registered importer by type', () => {
    const importer = stubImporter('scraping');
    registry.register(importer);

    expect(registry.get('scraping')).toBe(importer);
  });

  it('refuses a second importer for the same type', () => {
    registry.register(stubImporter('scraping'));

    // Silently replacing would mean the importer that runs depends on module
    // init order, which is exactly the kind of thing nobody notices until a
    // nightly run does the wrong work.
    expect(() => registry.register(stubImporter('scraping'))).toThrow(
      /already registered/,
    );
  });

  it('throws a type-naming error for an unregistered type', () => {
    expect(() => registry.get('arukereso')).toThrow(
      /No importer registered for product source type "arukereso"/,
    );
  });

  it('only ever holds types the union declares', () => {
    for (const type of PRODUCT_SOURCE_TYPES) {
      registry.register(stubImporter(type));
    }

    expect(registry.types().sort()).toEqual([...PRODUCT_SOURCE_TYPES].sort());
    for (const type of registry.types()) {
      expect(PRODUCT_SOURCE_TYPES).toContain(type);
    }
  });

  it('declares exactly the types this codebase intends to support', () => {
    expect([...PRODUCT_SOURCE_TYPES]).toEqual(['scraping', 'arukereso']);
  });

  // The other direction, and the one that actually bites: a declared type with
  // no importer is invisible until a nightly run throws. Asserted against the
  // real onModuleInit rather than a restated list, so adding a type without
  // wiring its importer fails here instead of at 02:00.
  it('wires an importer for every declared type', () => {
    const module = new ProductScraperModule(
      registry,
      { type: 'scraping' } as unknown as ScrapingImportService,
      { type: 'arukereso' } as unknown as ArukeresoImportService,
    );

    module.onModuleInit();

    expect(registry.types().sort()).toEqual([...PRODUCT_SOURCE_TYPES].sort());
  });
});
