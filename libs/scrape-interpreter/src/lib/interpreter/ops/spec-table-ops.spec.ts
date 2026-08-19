import * as cheerio from 'cheerio';
import { extractSpecTableV1, extractSpecTableV2 } from './spec-table-ops';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';

function makeContext(html: string): ScrapeExecutionContext {
  const $ = cheerio.load(html);
  return {
    $,
    html,
    task: { id: 'task-1', url: 'https://example.com' } as any,
    vars: {},
    runtime: {} as any,
    opts: {},
  };
}

describe('extractSpecTableV1', () => {
  it('detects section headers and collects multi-value props, deduped by name', () => {
    const ctx = makeContext(`
      <table class="product-properties">
        <tr><td class="prop-name"><h3>General</h3></td><td></td></tr>
        <tr><td class="prop-name">Connectivity<span class="hint" data-content="Ports available"></span></td>
            <td><div class="prop"><div class="name">USB-C</div></div><div class="prop"><div class="name">HDMI</div></div></td></tr>
        <tr><td class="prop-name">Connectivity</td><td><div class="prop"><div class="name">Duplicate</div></div></td></tr>
      </table>
    `);

    const result = extractSpecTableV1(ctx, undefined, {
      op: 'extractSpecTableV1',
      rowSelector: 'table.product-properties tr',
      sectionHeaderSelector: 'h3',
      nameSelector: 'td.prop-name',
      nameExcludeChildren: true,
      valueCellIndex: 1,
      listValueSelector: '.prop .name',
      descriptionSelector: '.hint',
      descriptionAttr: 'data-content',
      dedupeBy: 'name',
    }) as any[];

    expect(result).toEqual([
      {
        sectionTitle: 'General',
        name: 'Connectivity',
        description: 'Ports available',
        values: ['USB-C', 'HDMI'],
      },
    ]);
  });
});

describe('extractSpecTableV2', () => {
  it('falls back to an icon title for boolean-style yes/no values', () => {
    const ctx = makeContext(`
      <table class="property-sheet">
        <tr class="property-title"><td>Features</td></tr>
        <tr>
          <td class="property-name">HDR Support</td>
          <td class="property-value">
            <div><span class="icon-ok" title="Yes"></span></div>
          </td>
        </tr>
      </table>
    `);

    const result = extractSpecTableV2(ctx, undefined, {
      op: 'extractSpecTableV2',
      rowSelector: 'table.property-sheet tr',
      sectionHeaderRowClass: 'property-title',
      nameSelector: '.property-name',
      descriptionSelector: '.icon-help-circled',
      descriptionAttr: 'data-content',
      valueContainerSelector: '.property-value div',
      valueIconFallback: { selector: '.icon-ok, .icon-cancel', attr: 'title' },
      dedupeBy: 'name',
    }) as any[];

    expect(result).toEqual([
      {
        sectionTitle: 'Features',
        name: 'HDR Support',
        description: undefined,
        values: ['Yes'],
      },
    ]);
  });
});
