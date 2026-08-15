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
    url: 'https://www.displayspecifications.com/en/model/abc123',
  } as ScrapeTask;
}

describe('DisplaySpecs detail page — declarative config golden fixture', () => {
  let interpreter: ScrapeInterpreterService;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());

    const runtime: RuntimeDataProvider = {
      getBrandNames: jest.fn().mockResolvedValue([]),
      getCategoryBySlug: jest.fn(),
    };

    interpreter = new ScrapeInterpreterService(runner, runtime as never);
  });

  it('extracts brand/model/aliases/year via mapSpecValue and defaults to monitors when no TV section titles are present', async () => {
    const html = `
      <header class="section-header"><h2 class="header">General information</h2></header>
      <table class="model-information-table">
        <tbody>
          <tr><td>Brand</td><td>BenQ</td></tr>
          <tr><td>Model</td><td>MA270S</td></tr>
          <tr><td>Model alias<p>also known as</p></td><td>MA270S-B<br/>MA270</td></tr>
          <tr><td>Model year</td><td>2024</td></tr>
        </tbody>
      </table>
    `;
    const $ = cheerio.load(html);
    const config = displayspecsConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.brand).toBe('BenQ');
    expect(result.model).toBe('MA270S');
    expect(result.aliases).toEqual(['MA270S-B', 'MA270']);
    expect(result.releaseYear).toBe(2024);
    // No "Video file formats"/"Audio file formats"/"TV tuner" section titles
    // present -> falls through to the always-true monitors rule.
    expect(result.categorySlug).toBe('monitors');
  });

  it('resolves to tvs when a TV-only section title is present', async () => {
    const html = `
      <header class="section-header"><h2 class="header">General information</h2></header>
      <table class="model-information-table">
        <tbody>
          <tr><td>Brand</td><td>Samsung</td></tr>
          <tr><td>Model</td><td>QN90D</td></tr>
        </tbody>
      </table>
      <header class="section-header"><h2 class="header">TV tuner</h2></header>
      <table class="model-information-table">
        <tbody>
          <tr><td>DVB-T2</td><td>Yes</td></tr>
        </tbody>
      </table>
    `;
    const $ = cheerio.load(html);
    const config = displayspecsConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.categorySlug).toBe('tvs');
  });

  it('filters aliases equal to the model itself, case-insensitively', async () => {
    const html = `
      <header class="section-header"><h2 class="header">General information</h2></header>
      <table class="model-information-table">
        <tbody>
          <tr><td>Brand</td><td>LG</td></tr>
          <tr><td>Model</td><td>27GP850</td></tr>
          <tr><td>Model alias</td><td>27GP850<br/>27gp850-b</td></tr>
        </tbody>
      </table>
    `;
    const $ = cheerio.load(html);
    const config = displayspecsConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.aliases).toEqual(['27gp850-b']);
  });
});
