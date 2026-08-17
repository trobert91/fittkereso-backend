import * as cheerio from 'cheerio';
import { ProductSourceConfig, ScrapeTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import speedbikeConfig from './speedbike.config.json';

// Trimmed real capture of speedbike.hu's server-rendered detail page markup
// (KTM Macina Scarp SX Prestige Di2, Olive Pearl — saved from
// docs/products/... in this repo's working directory during onboarding),
// reduced to the structural pieces the config actually reads: the inline
// `ShopRenter.product` script blob, the schema.org breadcrumb, and the
// `table.parameter_table` spec sheet.
function buildHtml(): string {
  return `
    <html>
      <head>
        <script>
          var BASEURL = 'https://speedbike.hu';
          var ShopRenter = ShopRenter || {}; ShopRenter.product = {"id":92513,"sku":"1260044103","currency":"HUF","unitName":"db","price":3045957,"name":"KTM MACINA SCARP SX PRESTIGE Di2  M/43 Összteleszkópos elektromos  MTB kerékpár OLIVE PEARL színben","brand":"KTM","currentVariant":[],"parent":{"id":92513,"sku":"1260044103","unitName":"db","price":3045957,"name":"KTM MACINA SCARP SX PRESTIGE Di2  M/43 Összteleszkópos elektromos  MTB kerékpár OLIVE PEARL színben"}};
        </script>
      </head>
      <body>
        <section class="pathway-container">
          <div itemscope itemtype="http://schema.org/BreadcrumbList">
            <span itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
              <a itemprop="item" href="https://speedbike.hu/"><span itemprop="name">Kezdőlap</span></a>
            </span>
            <span itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
              <a itemprop="item" href="https://speedbike.hu/fotermekkategoria-1122"><span itemprop="name">Termékkategóriák</span></a>
            </span>
            <span itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
              <a itemprop="item" href="https://speedbike.hu/fotermekkategoria-1122/elektromos-kerekpar"><span itemprop="name">E-BIKE</span></a>
            </span>
            <span itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
              <a itemprop="item" href="https://speedbike.hu/fotermekkategoria-1122/elektromos-kerekpar/osszteleszkopos-e-bike"><span itemprop="name">Összteleszkópos E-BIKE</span></a>
            </span>
            <span itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
              <span itemprop="name">KTM MACINA SCARP SX PRESTIGE Di2  M/43 Összteleszkópos elektromos  MTB kerékpár OLIVE PEARL színben</span>
            </span>
          </div>
        </section>
        <span class="price price_special_color product_table_special">3.045.957 Ft</span>
        <table class="parameter_table">
          <tbody>
            <tr class="odd row-param-ebike_akkuteljesitmeny"><td><strong>wattora</strong></td><td>400 Wh</td></tr>
            <tr class="even row-param-ebike_evjarat"><td><strong>E-bike évjárat</strong></td><td>2026</td></tr>
            <tr class="odd"><td><strong>Váz</strong></td><td>Macina Scarp Prem CB 140 UDH|CPT400 Bosch BDU31/M4830</td></tr>
            <tr class="even"><td><strong>Villa</strong></td><td>FOX 36SL Float 29" Factory 140mm</td></tr>
            <tr class="odd"><td><strong>Első fék</strong></td><td>Shimano XT M8200/BR-M8220</td></tr>
            <tr class="odd"><td><strong>Súly</strong></td><td>17,9 kg</td></tr>
          </tbody>
        </table>
      </body>
    </html>
  `;
}

function makeTask(): ScrapeTask {
  return {
    id: 'task-1',
    url: 'https://speedbike.hu/ktm-macina-scarp-sx-prestige-di2-m43-osszteleszkopos-elektromos-mtb-kerekpar-olive-pearl-szinben',
  } as ScrapeTask;
}

describe('speedbike.hu detail page — declarative config golden fixture', () => {
  let interpreter: ScrapeInterpreterService;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());

    const runtime: RuntimeDataProvider = {
      getBrandNames: jest.fn().mockResolvedValue(['KTM']),
      getCategoryBySlug: jest.fn(),
    };

    interpreter = new ScrapeInterpreterService(runner, runtime as never);
  });

  it('extracts brand/model/externalId/category/rawSpecs from the real page structure', async () => {
    const $ = cheerio.load(buildHtml());
    const config = speedbikeConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.brand).toBe('KTM');
    expect(result.model).toBe(
      "MACINA SCARP SX PRESTIGE Di2  M/43 Összteleszkópos elektromos  MTB kerékpár OLIVE PEARL színben",
    );
    expect(result.externalId).toBe('1260044103');
    expect(result.categorySlug).toBe('ebikes');

    expect(result.rawSpecs).toEqual([
      { name: 'wattora', sectionTitle: undefined, description: undefined, values: ['400 Wh'] },
      { name: 'E-bike évjárat', sectionTitle: undefined, description: undefined, values: ['2026'] },
      { name: 'Váz', sectionTitle: undefined, description: undefined, values: ['Macina Scarp Prem CB 140 UDH|CPT400 Bosch BDU31/M4830'] },
      { name: 'Villa', sectionTitle: undefined, description: undefined, values: ['FOX 36SL Float 29" Factory 140mm'] },
      { name: 'Első fék', sectionTitle: undefined, description: undefined, values: ['Shimano XT M8200/BR-M8220'] },
      { name: 'Súly', sectionTitle: undefined, description: undefined, values: ['17,9 kg'] },
    ]);

    expect(result.releaseYear).toBe(2026);

    expect(result.rawOffers).toEqual([
      {
        sellerName: 'speedbike.hu',
        price: 3045957,
        currency: 'HUF',
        url: 'https://speedbike.hu/ktm-macina-scarp-sx-prestige-di2-m43-osszteleszkopos-elektromos-mtb-kerekpar-olive-pearl-szinben',
        sourceListingId: '1260044103',
      },
    ]);
  });
});
