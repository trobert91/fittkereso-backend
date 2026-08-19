import {
  AppendSyntheticSpecOp,
  ExtractSpecTableBySectionOp,
  ExtractSpecTableV1Op,
  ExtractSpecTableV2Op,
} from '@fittkereso-backend/database';
import { ScrapedProductSpec } from '@fittkereso-backend/product';
import { CheerioSelection } from '../interfaces/scrape-execution-context.interface';
import { OpHandler } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';

function dedupeByName(specs: ScrapedProductSpec[]): ScrapedProductSpec[] {
  const seen = new Set<string>();
  return specs.filter((spec) => {
    if (seen.has(spec.name)) return false;
    seen.add(spec.name);
    return true;
  });
}

// Árukereső "V1" layout: table.product-properties, <h3> section headers
// inline in the name cell, optional multi-value <div class="prop"><div
// class="name">.
export const extractSpecTableV1: OpHandler<ExtractSpecTableV1Op> = (
  ctx,
  _input,
  op,
) => {
  const specs: ScrapedProductSpec[] = [];
  let currentSection: string | undefined;

  ctx.$(op.rowSelector).each((_i, tr) => {
    const $tr = ctx.$(tr);
    const nameCell = $tr.find(op.nameSelector);
    const valueCell = $tr.find('td').eq(op.valueCellIndex);
    if (!nameCell.length) return;

    const sectionHeader = nameCell.find(op.sectionHeaderSelector);
    if (sectionHeader.length > 0) {
      currentSection = sectionHeader.text().trim();
      return;
    }

    const name = op.nameExcludeChildren
      ? nameCell.clone().children().remove().end().text().trim()
      : nameCell.text().trim();
    if (!name) return;

    const description = nameCell.find(op.descriptionSelector).attr(op.descriptionAttr)?.trim();

    const values: string[] = [];
    const listValues = valueCell.find(op.listValueSelector);
    if (listValues.length > 0) {
      listValues.each((_j, el) => {
        const val = ctx.$(el).text().trim();
        if (val) values.push(val);
      });
    } else {
      const text = valueCell.text().trim();
      if (text) values.push(text);
    }

    specs.push({ sectionTitle: currentSection, name, description, values });
  });

  return op.dedupeBy === 'name' ? dedupeByName(specs) : specs;
};

// Árukereső "V2" layout: table.property-sheet, section rows marked by a CSS
// class, icon-based Yes/No value fallback.
export const extractSpecTableV2: OpHandler<ExtractSpecTableV2Op> = (
  ctx,
  _input,
  op,
) => {
  const specs: ScrapedProductSpec[] = [];
  let currentSectionTitle: string | undefined;

  ctx.$(op.rowSelector).each((_i, el) => {
    const $row = ctx.$(el);

    if ($row.hasClass(op.sectionHeaderRowClass)) {
      currentSectionTitle = $row.text().trim();
      return;
    }

    const name = $row.find(op.nameSelector).text().trim();
    const description = $row
      .find(op.descriptionSelector)
      .attr(op.descriptionAttr)
      ?.trim();

    const values: string[] = [];
    $row.find(op.valueContainerSelector).each((_j, div) => {
      const text = ctx.$(div).text().trim();
      if (text) {
        values.push(text);
      } else if (op.valueIconFallback) {
        const icon = ctx
          .$(div)
          .find(op.valueIconFallback.selector)
          .first();
        const title = icon.attr(op.valueIconFallback.attr);
        if (title) values.push(title.trim());
      }
    });

    if (name) {
      specs.push({
        name,
        sectionTitle: currentSectionTitle,
        description,
        values: values.length ? values : undefined,
      });
    }
  });

  return op.dedupeBy === 'name' ? dedupeByName(specs) : specs;
};

// DisplaySpecs layout: one section-header per table, rows split on <br> for
// multi-value cells.
export const extractSpecTableBySection: OpHandler<
  ExtractSpecTableBySectionOp
> = (ctx, input, op) => {
  const sections = input as CheerioSelection;
  const specs: ScrapedProductSpec[] = [];

  sections.each((_i, header) => {
    const $header = ctx.$(header);
    const sectionTitle = $header.find(op.sectionTitleSelector).text().trim();

    const table =
      op.tableRelation === 'nextAll'
        ? $header.nextAll(op.tableSelector)
        : $header.next(op.tableSelector);
    const targetTable = op.tableFirst === false ? table : table.first();
    if (!targetTable.length) return;

    targetTable.find(op.rowSelector).each((_j, row) => {
      const cells = ctx.$(row).find('td');
      if (cells.length < op.minCells) return;

      const nameCell = ctx.$(cells[op.nameCellIndex]);
      const valueCell = ctx.$(cells[op.valueCellIndex]);

      const name = op.nameExcludeChildren
        ? nameCell.clone().children(op.nameExcludeChildren).remove().end().text().trim()
        : nameCell.text().trim();

      const description =
        ctx.$(cells[op.descriptionCellIndex]).find(op.descriptionSelector).text().trim() ||
        undefined;

      const rawValueHtml = valueCell.html() ?? '';
      const valueText = valueCell.text().trim();

      const splitRegex = new RegExp(op.splitValueOn, 'i');
      const values = op.htmlAware
        ? rawValueHtml
            .split(splitRegex)
            .map((s) => ctx.$.load(s).text().trim())
            .filter((v) => v.length > 0)
        : valueText.split(splitRegex).map((v) => v.trim()).filter(Boolean);

      specs.push({
        sectionTitle,
        name,
        description,
        values: values.length > 0 ? values : [valueText],
      });
    });
  });

  return specs;
};

export function makeAppendSyntheticSpec(
  runner: ScrapePipelineRunnerService,
): OpHandler<AppendSyntheticSpecOp> {
  return async (ctx, input, op) => {
    const specs = [...((input as ScrapedProductSpec[]) ?? [])];
    const value = (await runner.run(op.value, ctx)) as string | undefined;
    if (value) {
      specs.push({ name: op.name, values: [value] });
    }
    return specs;
  };
}
