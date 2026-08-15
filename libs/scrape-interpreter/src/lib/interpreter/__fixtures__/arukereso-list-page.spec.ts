import * as cheerio from 'cheerio';
import { ProductSourceConfig, ScrapeTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import arukeresoConfig from './arukereso.config.json';

function makeTask(): ScrapeTask {
  return {
    id: 'task-1',
    url: 'https://www.arukereso.hu/monitorok/',
  } as ScrapeTask;
}

describe('Arukereso list page — declarative config golden fixture', () => {
  let interpreter: ScrapeInterpreterService;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());

    const runtime: RuntimeDataProvider = {
      getBrandNames: jest.fn().mockResolvedValue(['ASUS', 'LG']),
      getCategoryBySlug: jest.fn(),
    };

    interpreter = new ScrapeInterpreterService(runner, runtime as never);
  });

  it('extracts category name, brand-filtered product links, and pagination for a first-page listing', async () => {
    const html = `
      <h1 class="category-title">Monitor</h1>
      <div class="category-navbar"><span class="product-num">76 termék, 1. oldal</span></div>
      <div class="list-view">
        <div class="product-box" data-akpid="111">
          <a href="/monitorok/asus/asus-pg27-p111" title="ASUS PG27"></a>
        </div>
        <div class="product-box" data-akpid="222">
          <a href="/monitorok/lg/lg-27gp-p222" title="LG 27GP"></a>
        </div>
        <div class="product-box" data-akpid="333">
          <a href="/monitorok/nomatch/x-p333" title="NoMatch Brand"></a>
        </div>
      </div>
    `;
    const $ = cheerio.load(html);
    const config = arukeresoConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    expect(result.categoryName).toBe('Monitor');
    expect(result.productLinks).toEqual([
      {
        url: '/monitorok/asus/asus-pg27-p111/#termek-leiras',
        title: 'ASUS PG27',
      },
      {
        url: '/monitorok/lg/lg-27gp-p222/#termek-leiras',
        title: 'LG 27GP',
      },
    ]);
    // 76 products / 25 per page = ceil(3.04) = 4 pages -> pages 2,3,4 generated.
    expect(result.categoryLinks).toEqual([
      { url: 'https://www.arukereso.hu/monitorok/?start=25', title: 'Page 2' },
      { url: 'https://www.arukereso.hu/monitorok/?start=50', title: 'Page 3' },
      { url: 'https://www.arukereso.hu/monitorok/?start=75', title: 'Page 4' },
    ]);
  });

  it('produces no pagination links when not on the first page', async () => {
    const html = `
      <h1 class="category-title">Monitor</h1>
      <div class="category-navbar"><span class="product-num">76 termék, 2. oldal</span></div>
      <div class="list-view"></div>
    `;
    const $ = cheerio.load(html);
    const config = arukeresoConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    expect(result.categoryLinks).toEqual([]);
  });
});
