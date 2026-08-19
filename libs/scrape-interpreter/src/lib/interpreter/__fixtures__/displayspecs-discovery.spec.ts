import * as cheerio from 'cheerio';
import { ProductSourceConfig, ScrapeTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import displayspecsConfig from './displayspecs.config.json';

function makeTask(): ScrapeTask {
  return {
    id: 'task-1',
    url: 'https://www.displayspecifications.com',
  } as ScrapeTask;
}

describe('DisplaySpecs discovery — declarative config golden fixture', () => {
  it('matches brand-listing links against the known Brand entity list, resolving relative hrefs', async () => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());

    const runtime: RuntimeDataProvider = {
      getBrandNames: jest.fn().mockResolvedValue(['BenQ', 'Samsung']),
      getCategoryBySlug: jest.fn(),
    };
    const interpreter = new ScrapeInterpreterService(runner, runtime as never);

    const html = `
      <div class="brand-listing-container-frontpage">
        <a href="/en/brand/benq">BenQ</a>
        <a href="/en/brand/samsung">Samsung</a>
        <a href="/en/brand/unknown-oem">Unknown OEM</a>
      </div>
    `;
    const $ = cheerio.load(html);
    const config = displayspecsConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDiscovery(makeTask(), $, config, {
      brandNames: ['BenQ', 'Samsung'],
    });

    expect(result).toEqual([
      { url: 'https://www.displayspecifications.com/en/brand/benq', title: 'BenQ' },
      { url: 'https://www.displayspecifications.com/en/brand/samsung', title: 'Samsung' },
    ]);
  });
});
