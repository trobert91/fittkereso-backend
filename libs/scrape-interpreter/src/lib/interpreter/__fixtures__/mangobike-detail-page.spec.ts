import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import {
  ProductImportTask,
  SourceSpecConfig,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  SpecExtractionService,
  ProductSpecNormalizationService,
} from '@fittkereso-backend/product';
import { DetailPageSourceConfig, ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
// The category's real, current schema, as speedbike-detail-page.spec.ts reads it.
// eslint-disable-next-line @nx/enforce-module-boundaries
import ebikesJsonSchema from '../../../../../config/src/lib/categories/ebikes/jsonSchema.json';

// Real capture of mangobike.hu's product page for its Árukereső row 24384 (KTM
// Macina Tour PX 610, 51 cm, fetched directly on 2026-10-08), trimmed to the
// pieces a feed's detailPage reads: the "Termékinformációk" tabs (#property-tabs:
// the 42-row spec list in #tab1-pane, the description in #tab2-pane) and the
// page's schema.org Product and BreadcrumbList scripts.
//
// The feed row has no specs at all (mangobike's Árukereső export has 11 columns
// and no attributes); this page is where gender, weight, gear count and the
// motor's torque are.
const html = fs.readFileSync(
  path.join(__dirname, 'mangobike', 'ktm-macina-tour-px-610-24384.html'),
  'utf8',
);

// A feed source's detailPage: only the parts it wants from the page — no
// category (the feed decides it), no brand or model (the feed row has them).
const config: DetailPageSourceConfig = {
  baseUrl: 'https://www.mangobike.hu',
  categories: { ebikes: { enabled: true, rules: [{ when: { always: true } }] } },
  detailPage: {
    rawSpecs: [
      {
        op: 'extractSpecTableV2',
        rowSelector: '#tab1-pane .v-properties-box-parts-properties-002 > div',
        sectionHeaderRowClass: 'v-properties-section-header',
        nameSelector: 'span:first-child',
        descriptionSelector: '.hint',
        descriptionAttr: 'data-content',
        valueContainerSelector: 'span.fw-bold',
        dedupeBy: 'name',
      },
    ],
    description: [{ op: 'selectText', selector: '#tab2-pane', first: true, trim: true }],
  },
};

// The shop writes every label with a trailing colon, and labels are matched
// exactly, so the mapping names them that way.
const specMapping: SourceSpecConfig = {
  mappings: [
    { key: 'gender', labels: ['Neme:'] },
    { key: 'torque', labels: ['Motor típusa:'], extractPatterns: ['(\\d+)\\s*Nm'], extract: 'number' },
    { key: 'weight', labels: ['Súly:'], extract: 'number' },
    { key: 'gearCount', labels: ['Fokozatszám:'], extract: 'number' },
    { key: 'wheelSize', labels: ['Kerékméret:'], extract: 'number' },
    { key: 'frameMaterial', labels: ['Váz anyaga:'] },
    { key: 'batteryCapacity', labels: ['Akkumulátor mérete:'], extract: 'number' },
  ],
};

describe('mangobike.hu product page, read as a feed source reads it', () => {
  let interpreter: ScrapeInterpreterService;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());
    const runtime: RuntimeDataProvider = {
      getBrandNames: async () => [],
      getCategoryBySlug: async () => null,
    } as unknown as RuntimeDataProvider;
    interpreter = new ScrapeInterpreterService(runner, runtime as never);
  });

  const read = () =>
    interpreter.runDetailPage(
      { id: 'task-1', url: 'https://www.mangobike.hu/ktm-macina-tour-px-610-kek-4' } as ProductImportTask,
      cheerio.load(html),
      config,
    );

  it('reads every row of the spec list', async () => {
    const result = await read();
    const row = (name: string) => result.rawSpecs.find((spec) => spec.name === name)?.values;

    expect(result.rawSpecs).toHaveLength(42);
    expect(row('Cikkszám:')).toEqual(['KT-1260161111']);
    expect(row('Neme:')).toEqual(['Férfi']);
    expect(row('Motor típusa:')).toEqual(['Bosch Performance Line PX (90 Nm)']);
    expect(row('Súly:')).toEqual(['26.9 kg']);
    expect(row('Fokozatszám:')).toEqual(['10']);
    expect(row('Vázméret:')).toEqual(['51 cm']);
  });

  it('reads the description, and nothing the config does not ask for', async () => {
    const result = await read();

    expect(result.description).toMatch(/^QUALITY\. COMFORT\. POWER\. STYLE\./);
    expect(result.description).toContain('90 Nm nyomaték');
    expect(result.brand).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.categorySlug).toBeUndefined();
    expect(result.imageUrls).toEqual([]);
    expect(result.rawOffers).toEqual([]);
  });

  // What the page adds to a row whose feed has none of these.
  it('maps the rows onto the ebikes specs the feed lacks', async () => {
    const result = await read();
    const specs = new SpecExtractionService(new ProductSpecNormalizationService()).extractSpecs({
      scrapedSpecs: result.rawSpecs,
      schema: ebikesJsonSchema as unknown as SpecDefinitionJsonSchema,
      sourceConfig: specMapping,
    });

    expect(specs).toMatchObject({
      gender: 'Férfi',
      torque: 90,
      weight: 26.9,
      gearCount: 10,
      wheelSize: 28,
      frameMaterial: 'Alumínium',
      batteryCapacity: 600,
    });
  });
});
