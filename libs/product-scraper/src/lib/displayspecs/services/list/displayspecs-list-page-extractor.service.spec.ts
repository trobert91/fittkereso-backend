import { ScrapeTask } from '@fittkereso-backend/database';
import * as cheerio from 'cheerio';
import { DisplayspecsListPageExtractor } from './displayspecs-list-page-extractor.service';

describe('DisplayspecsListPageExtractor', () => {
  const extractor = new DisplayspecsListPageExtractor();

  it('skips empty section headers and finds model containers before the next section header', async () => {
    const currentYear = new Date().getFullYear();
    const previousYear = currentYear - 1;
    const oldYear = currentYear - 4;

    const $ = cheerio.load(`
      <header class="section-header">
        <h1 class="header"></h1>
      </header>
      <div class="consent-banner"></div>

      <header class="section-header">
        <h1 class="header">BenQ - ${currentYear} - Desktop monitors</h1>
      </header>
      <div class="ad-slot"></div>
      <div class="model-listing-container-80">
        <div id="model_1">
          <h3><a href="https://www.displayspecifications.com/en/model/new1">27&quot; MA270S</a></h3>
        </div>
      </div>

      <header class="section-header">
        <h1 class="header">BenQ - ${previousYear} - Desktop monitors</h1>
      </header>
      <div class="model-listing-container-80">
        <div id="model_2">
          <h3><a href="https://www.displayspecifications.com/en/model/new2">31.5&quot; MA320UG</a></h3>
        </div>
      </div>

      <header class="section-header">
        <h1 class="header">BenQ - ${oldYear} - Desktop monitors</h1>
      </header>
      <div class="model-listing-container-80">
        <div id="model_3">
          <h3><a href="https://www.displayspecifications.com/en/model/old1">27&quot; OldModel</a></h3>
        </div>
      </div>
    `);

    const links = await extractor.getProductLinks(
      { id: 'task-1' } as ScrapeTask,
      $,
    );

    expect(links).toEqual([
      {
        category: `BenQ - ${currentYear} - Desktop monitors`,
        title: 'BenQ MA270S',
        url: 'https://www.displayspecifications.com/en/model/new1',
      },
      {
        category: `BenQ - ${previousYear} - Desktop monitors`,
        title: 'BenQ MA320UG',
        url: 'https://www.displayspecifications.com/en/model/new2',
      },
    ]);
  });
});
