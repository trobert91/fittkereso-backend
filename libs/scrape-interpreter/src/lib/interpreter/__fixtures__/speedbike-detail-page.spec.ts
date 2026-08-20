import * as cheerio from 'cheerio';
import {
  ProductSourceConfig,
  ScrapeTask,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  SpecExtractionService,
  ProductSpecNormalizationService,
} from '@fittkereso-backend/product';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import speedbikeConfig from './speedbike.config.json';
import ebikesJsonSchema from '../../../../../config/src/lib/categories/ebikes/jsonSchema.json';

// Real capture of speedbike.hu's server-rendered detail page markup (KTM
// Macina Scarp SX Prestige Di2, Olive Pearl — saved from docs/products/...
// in this repo's working directory during onboarding), trimmed to the
// structural pieces the config actually reads: the inline `ShopRenter.product`
// script blob, the schema.org breadcrumb, the full `table.parameter_table`
// spec sheet (all 55 rows, several intentionally empty — a real listing
// never fills every attribute), and the `og:image` meta tag.
//
// Note: the site's actual product image gallery (`#productimages_wrapper`,
// `.fancybox`/`.product-images img`) is injected client-side by JS after
// page load and is NOT present in the server-rendered HTML a non-JS-
// rendering fetch (e.g. Zyte extract) sees — confirmed by fetching the real
// page and finding no `<img>` elements under those selectors, only the
// fancybox library's own <script>/<link> tags. The one reliable
// statically-rendered product image reference is the `og:image` meta tag,
// which is what `detailPage.images` targets instead.
function buildHtml(): string {
  return `
    <html>
      <head>
        <meta property="og:image" content="https://speedbike2.cdn.shoprenter.hu/custom/speedbike2/image/cache/w1955h1024q100/KTM-2026/1260044108.webp?lastmod=1761570968.1772457778" />
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
            <tr class="odd"><td><strong>Lengéscsillapító</strong></td><td>FOX Float Factory 2-Pos 230x60</td></tr>
            <tr class="even"><td><strong>Hajtás</strong></td><td>1X11 SHIMANO DEORE XT DI2 LG</td></tr>
            <tr class="odd"><td><strong>E-System</strong></td><td>BOSCH CPT-SX4R4</td></tr>
            <tr class="even"><td><strong>Motor</strong></td><td>Bosch PERFORMANCE SX BDU3144</td></tr>
            <tr class="odd"><td><strong>Kijelző</strong></td><td></td></tr>
            <tr class="even"><td><strong>Akkumulátor</strong></td><td>Bosch CompactTUBE 400Wh</td></tr>
            <tr class="odd"><td><strong>Akku zár</strong></td><td>ABUS integrated btry lock IT2 (T82 key)</td></tr>
            <tr class="even"><td><strong>Töltő</strong></td><td>Bosch STANDARD Charger 4A</td></tr>
            <tr class="odd"><td><strong>GPS modul</strong></td><td></td></tr>
            <tr class="even"><td><strong>ABS</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Hátsó váltó</strong></td><td>Shimano Deore XT Di2 M8260-11 LG SGS</td></tr>
            <tr class="even"><td><strong>Első váltó</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Váltókar bal</strong></td><td></td></tr>
            <tr class="even"><td><strong>Váltókar jobb</strong></td><td>Shimano Deore XT Di2 M8250</td></tr>
            <tr class="odd"><td><strong>Hajtókar</strong></td><td>RACE FACE AEFFECT-R170</td></tr>
            <tr class="even"><td><strong>Hajtókar bal</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Hajtókar jobb</strong></td><td></td></tr>
            <tr class="even"><td><strong>Középcsapágy</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Lánckerék</strong></td><td>KTM aluminium 34T Direct Mount</td></tr>
            <tr class="even"><td><strong>Fogaskoszorú</strong></td><td>Shimano LG700-11 / 11-50</td></tr>
            <tr class="odd"><td><strong>Lánc</strong></td><td>KMC e11 Sport EPT e-bike</td></tr>
            <tr class="even"><td><strong>Első fék</strong></td><td>Shimano XT M8200/BR-M8220</td></tr>
            <tr class="odd"><td><strong>Hátsó fék</strong></td><td>Shimano XT M8200/BR-M8220</td></tr>
            <tr class="even"><td><strong>Első féktárcsa</strong></td><td>Shimano CL800 CL 203 freeza</td></tr>
            <tr class="odd"><td><strong>Hátsó féktárcsa</strong></td><td>Shimano CL800 CL 180 freeza</td></tr>
            <tr class="even"><td><strong>Első kerék</strong></td><td>DT HXC 1501 Spline LS 29 Carbon CL 110/15TA|622x30TSS TLR</td></tr>
            <tr class="odd"><td><strong>Első felni</strong></td><td></td></tr>
            <tr class="even"><td><strong>Első agy</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Első küllők</strong></td><td></td></tr>
            <tr class="even"><td><strong>Hátsó kerék</strong></td><td>DT HXC 1501 Spline LS 29 Carbon CL 148/12TA|622x30TSS SS TLR</td></tr>
            <tr class="odd"><td><strong>Hátsó felni</strong></td><td></td></tr>
            <tr class="even"><td><strong>Hátsó agy</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Hátsó küllők</strong></td><td></td></tr>
            <tr class="even"><td><strong>Első gumi</strong></td><td>Schwalbe Wicked Will Evo SuperGround TLE 62-622</td></tr>
            <tr class="odd"><td><strong>Hátsó gumi</strong></td><td>Schwalbe Wicked Will Evo SuperGround TLE 62-622</td></tr>
            <tr class="even"><td><strong>Markolat</strong></td><td>ESI Chunky silicone</td></tr>
            <tr class="odd"><td><strong>Kormány</strong></td><td>FSA NS SIC cockpit ICR carbon</td></tr>
            <tr class="even"><td><strong>Kormányszár</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Kormánycsapágy</strong></td><td>FSA SRS drop/in 1.5" internal</td></tr>
            <tr class="even"><td><strong>Nyereg</strong></td><td>Fizik Terra Aidon X5 SAlloy</td></tr>
            <tr class="odd"><td><strong>Nyeregcső</strong></td><td>FOX Transfer Factory 30.9 internal</td></tr>
            <tr class="even"><td><strong>Nyeregbilincs</strong></td><td>KTM TEAM Light CL-FJ21 - 34,9mm</td></tr>
            <tr class="odd"><td><strong>Pedál</strong></td><td>MTB-Pedal flat VP-539 nylon</td></tr>
            <tr class="even"><td><strong>Hordozó</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Első lámpa</strong></td><td></td></tr>
            <tr class="even"><td><strong>Hátsó lámpa</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Első sárvédő</strong></td><td></td></tr>
            <tr class="even"><td><strong>Hátsó sárvédő</strong></td><td></td></tr>
            <tr class="odd"><td><strong>Láncvédő</strong></td><td></td></tr>
            <tr class="even"><td><strong>Kitámasztó</strong></td><td></td></tr>
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

    function row(name: string, value?: string) {
      return {
        name,
        sectionTitle: undefined,
        description: undefined,
        values: value ? [value] : [],
      };
    }

    expect(result.rawSpecs).toEqual([
      row('wattora', '400 Wh'),
      row('E-bike évjárat', '2026'),
      row('Váz', 'Macina Scarp Prem CB 140 UDH|CPT400 Bosch BDU31/M4830'),
      row('Villa', 'FOX 36SL Float 29" Factory 140mm'),
      row('Lengéscsillapító', 'FOX Float Factory 2-Pos 230x60'),
      row('Hajtás', '1X11 SHIMANO DEORE XT DI2 LG'),
      row('E-System', 'BOSCH CPT-SX4R4'),
      row('Motor', 'Bosch PERFORMANCE SX BDU3144'),
      row('Kijelző'),
      row('Akkumulátor', 'Bosch CompactTUBE 400Wh'),
      row('Akku zár', 'ABUS integrated btry lock IT2 (T82 key)'),
      row('Töltő', 'Bosch STANDARD Charger 4A'),
      row('GPS modul'),
      row('ABS'),
      row('Hátsó váltó', 'Shimano Deore XT Di2 M8260-11 LG SGS'),
      row('Első váltó'),
      row('Váltókar bal'),
      row('Váltókar jobb', 'Shimano Deore XT Di2 M8250'),
      row('Hajtókar', 'RACE FACE AEFFECT-R170'),
      row('Hajtókar bal'),
      row('Hajtókar jobb'),
      row('Középcsapágy'),
      row('Lánckerék', 'KTM aluminium 34T Direct Mount'),
      row('Fogaskoszorú', 'Shimano LG700-11 / 11-50'),
      row('Lánc', 'KMC e11 Sport EPT e-bike'),
      row('Első fék', 'Shimano XT M8200/BR-M8220'),
      row('Hátsó fék', 'Shimano XT M8200/BR-M8220'),
      row('Első féktárcsa', 'Shimano CL800 CL 203 freeza'),
      row('Hátsó féktárcsa', 'Shimano CL800 CL 180 freeza'),
      row('Első kerék', 'DT HXC 1501 Spline LS 29 Carbon CL 110/15TA|622x30TSS TLR'),
      row('Első felni'),
      row('Első agy'),
      row('Első küllők'),
      row('Hátsó kerék', 'DT HXC 1501 Spline LS 29 Carbon CL 148/12TA|622x30TSS SS TLR'),
      row('Hátsó felni'),
      row('Hátsó agy'),
      row('Hátsó küllők'),
      row('Első gumi', 'Schwalbe Wicked Will Evo SuperGround TLE 62-622'),
      row('Hátsó gumi', 'Schwalbe Wicked Will Evo SuperGround TLE 62-622'),
      row('Markolat', 'ESI Chunky silicone'),
      row('Kormány', 'FSA NS SIC cockpit ICR carbon'),
      row('Kormányszár'),
      row('Kormánycsapágy', 'FSA SRS drop/in 1.5" internal'),
      row('Nyereg', 'Fizik Terra Aidon X5 SAlloy'),
      row('Nyeregcső', 'FOX Transfer Factory 30.9 internal'),
      row('Nyeregbilincs', 'KTM TEAM Light CL-FJ21 - 34,9mm'),
      row('Pedál', 'MTB-Pedal flat VP-539 nylon'),
      row('Hordozó'),
      row('Első lámpa'),
      row('Hátsó lámpa'),
      row('Első sárvédő'),
      row('Hátsó sárvédő'),
      row('Láncvédő'),
      row('Kitámasztó'),
      row('Súly', '17,9 kg'),
    ]);

    expect(result.releaseYear).toBe(2026);

    expect(result.imageUrls).toEqual([
      'https://speedbike2.cdn.shoprenter.hu/custom/speedbike2/image/cache/w1955h1024q100/KTM-2026/1260044108.webp?lastmod=1761570968.1772457778',
    ]);

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

  it('deterministically maps the real page rawSpecs onto the current ebikes jsonSchema via specMapping', async () => {
    const $ = cheerio.load(buildHtml());
    const config = speedbikeConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    const specExtraction = new SpecExtractionService(
      new ProductSpecNormalizationService(),
    );
    const specs = specExtraction.extractSpecs({
      scrapedSpecs: result.rawSpecs,
      schema: ebikesJsonSchema as unknown as SpecDefinitionJsonSchema,
      sourceConfig: config.detailPage.specMapping!['ebikes'],
    });

    // Fields this page never fills a matching label for (frameType,
    // usageType, batteryPosition, drivetrain, suspension, brakeType,
    // gearType, motorPosition, motorPower, topSpeed, range, chargingTime,
    // display, maxLoad, waterResistance, smartConnectivity, gpsModule, abs)
    // are absent here — they fall through to the LLM post-process step,
    // same as before this test existed.
    expect(specs).toEqual({
      batteryCapacity: 400,
      // Hungarian comma-decimal ("17,9 kg") isn't parsed by extractFirstNumber
      // (it only recognizes a "." decimal separator), so this currently
      // resolves to 17, not 17.9 — a pre-existing extraction limitation
      // unrelated to this config, asserted here as-is rather than silently
      // "fixed" to the value it arguably should be.
      weight: 17,
      frameModel: 'Macina Scarp Prem CB 140 UDH|CPT400 Bosch BDU31/M4830',
      forkModel: 'FOX 36SL Float 29" Factory 140mm',
      rearShockModel: 'FOX Float Factory 2-Pos 230x60',
      ebikeSystem: 'BOSCH CPT-SX4R4',
      motorModel: 'Bosch PERFORMANCE SX BDU3144',
      batteryModel: 'Bosch CompactTUBE 400Wh',
      batteryLock: 'ABUS integrated btry lock IT2 (T82 key)',
      chargerModel: 'Bosch STANDARD Charger 4A',
      rearDerailleur: 'Shimano Deore XT Di2 M8260-11 LG SGS',
      shifter: 'Shimano Deore XT Di2 M8250',
      crankset: 'RACE FACE AEFFECT-R170',
      chainring: 'KTM aluminium 34T Direct Mount',
      cassette: 'Shimano LG700-11 / 11-50',
      chain: 'KMC e11 Sport EPT e-bike',
      brakeModel: 'Shimano XT M8200/BR-M8220',
      rotorModel: 'Shimano CL800 CL 203 freeza',
      wheelset: 'DT HXC 1501 Spline LS 29 Carbon CL 110/15TA|622x30TSS TLR',
      tireModel: 'Schwalbe Wicked Will Evo SuperGround TLE 62-622',
      grips: 'ESI Chunky silicone',
      handlebar: 'FSA NS SIC cockpit ICR carbon',
      headset: 'FSA SRS drop/in 1.5" internal',
      saddle: 'Fizik Terra Aidon X5 SAlloy',
      seatpost: 'FOX Transfer Factory 30.9 internal',
      seatClamp: 'KTM TEAM Light CL-FJ21 - 34,9mm',
      pedals: 'MTB-Pedal flat VP-539 nylon',
    });
  });
});
