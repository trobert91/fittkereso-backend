import {
  BuildBaseUrlOp,
  ComputePagesOp,
  ExtractLinkFromBoxOp,
  ExtractLinkTitlePairsOp,
  FilterByBrandPrefixOp,
  GeneratePaginationLinksOp,
  MatchAgainstRuntimeListOp,
  RuntimeDataSourceKey,
} from '@fittkereso-backend/database';
import { WebLink } from '@fittkereso-backend/product';
import { CheerioSelection } from '../interfaces/scrape-execution-context.interface';
import { OpHandler } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';

export const extractLinkTitlePairs: OpHandler<ExtractLinkTitlePairsOp> = (
  ctx,
  input,
  op,
) => {
  const anchors = input as CheerioSelection;
  const results: WebLink[] = [];

  anchors.each((_i, el) => {
    const $el = ctx.$(el);
    let href = $el.attr('href');
    if (!href) return;

    if (op.resolveRelativeAgainst) {
      const base = ctx.vars[op.resolveRelativeAgainst] as string | undefined;
      if (base && !/^https?:\/\//i.test(href)) {
        href = base.replace(/\/$/, '') + '/' + href.replace(/^\//, '');
      }
    }

    const title = op.titleFromOwnTextExcludingChildren
      ? $el.clone().children().remove().end().text().trim()
      : $el.text().trim();

    if (title) {
      results.push({ url: href, title });
    }
  });

  return results;
};

// Selection-of-boxes -> WebLink[]. Each "box" is one product/model card; the
// actual anchor is found inside via linkSelector, with an optional
// excludeHrefContains filter (e.g. Árukereső's outbound-redirect Jump.php
// links) and an optional urlTransform sub-pipeline (e.g. append an anchor
// fragment).
export function makeExtractLinkFromBox(
  runner: ScrapePipelineRunnerService,
): OpHandler<ExtractLinkFromBoxOp> {
  return async (ctx, input, op) => {
    const boxes = input as CheerioSelection;
    const results: WebLink[] = [];

    const boxEls = boxes.toArray();
    for (const boxEl of boxEls) {
      const $box = ctx.$(boxEl);
      let candidates = $box.find(op.linkSelector);
      const excludeHrefContains = op.excludeHrefContains;
      if (excludeHrefContains) {
        candidates = candidates.filter((_i, a) => {
          const href = ctx.$(a).attr('href');
          return !!href && !href.includes(excludeHrefContains);
        });
      }
      const linkEl = op.first === false ? candidates : candidates.first();
      if (linkEl.length === 0) continue;

      let url = linkEl.attr('href');
      if (!url) continue;

      if (op.urlTransform) {
        url = (await runner.run(op.urlTransform, ctx, url)) as string;
      }
      if (!url) continue;

      let title: string | undefined;
      for (const source of op.titleFrom ?? ['text']) {
        if (source === 'text') {
          title = linkEl.text().trim();
        } else if (source.startsWith('attr:')) {
          title = linkEl.attr(source.slice('attr:'.length))?.trim();
        }
        if (title) break;
      }
      if (!title) continue;

      if (op.titleTransform) {
        title = (await runner.run(op.titleTransform, ctx, title)) as string;
      }
      if (op.titleTemplate) {
        title = op.titleTemplate.replace(
          /\{\{\s*title\s*\}\}/,
          title ?? '',
        );
        for (const [key, value] of Object.entries(ctx.vars)) {
          if (typeof value === 'string') {
            title = title.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
          }
        }
      }

      const category = op.categoryFrom
        ? (ctx.vars[op.categoryFrom] as string | undefined)
        : undefined;

      results.push(category ? { url, title, category } : { url, title });
    }

    return results;
  };
}

function resolveRuntimeList(
  ctx: Parameters<OpHandler>[0],
  source: `runtime:${RuntimeDataSourceKey}`,
): Promise<string[]> {
  const key = source.slice('runtime:'.length) as RuntimeDataSourceKey;
  if (key === 'brandCache' || key === 'brandNames') {
    return ctx.runtime.getBrandNames();
  }
  throw new Error(`Runtime list source not supported: ${source}`);
}

export const matchAgainstRuntimeList: OpHandler<MatchAgainstRuntimeListOp> =
  async (ctx, input, op) => {
    const links = (input as WebLink[]) ?? [];
    const list = await resolveRuntimeList(ctx, op.source);
    const normalizedList = op.caseInsensitive
      ? list.map((t) => t.toLowerCase())
      : list;

    return links.filter((link) => {
      const fieldValue = (link as unknown as Record<string, string>)[op.field];
      if (!fieldValue) return false;
      const value = op.caseInsensitive ? fieldValue.toLowerCase() : fieldValue;
      return normalizedList.includes(value);
    });
  };

export const filterByBrandPrefix: OpHandler<FilterByBrandPrefixOp> = async (
  ctx,
  input,
  op,
) => {
  const links = (input as WebLink[]) ?? [];
  const brandNames = await resolveRuntimeList(ctx, op.source);
  const normalizedBrands = op.caseInsensitive
    ? brandNames.map((b) => b.toLowerCase())
    : brandNames;

  return links.filter((link) => {
    const fieldValue = (link as unknown as Record<string, string>)[op.field];
    if (!fieldValue) return false;
    const value = op.caseInsensitive ? fieldValue.toLowerCase() : fieldValue;
    return normalizedBrands.some((brand) => value.startsWith(brand));
  });
};

export const generatePaginationLinks: OpHandler<GeneratePaginationLinksOp> = (
  ctx,
  _input,
  op,
) => {
  const totalPages = ctx.vars[op.totalPages] as number | undefined;
  const baseUrl = ctx.vars[op.baseUrl] as string | undefined;
  if (!totalPages || !baseUrl) return [];

  const links: WebLink[] = [];
  for (let page = op.startPage; page <= totalPages; page++) {
    const url = op.urlTemplate
      .replace(/\{baseUrl\}/g, baseUrl)
      .replace(/\{\(page-1\)\*(\d+)\}/g, (_m, perPage: string) =>
        String((page - 1) * Number(perPage)),
      )
      .replace(/\{page\}/g, String(page));
    const title = op.titleTemplate.replace(/\{page\}/g, String(page));
    links.push({ url, title });
  }
  return links;
};

export const buildBaseUrl: OpHandler<BuildBaseUrlOp> = (ctx, _input, op) => {
  let url = ctx.task.url;
  if (op.stripQuery) {
    url = url.split('?')[0];
  }
  if (op.trimTrailingSlash) {
    url = url.replace(/\/+$/, '');
  }
  return url;
};

export const computePages: OpHandler<ComputePagesOp> = (ctx, _input, op) => {
  const totalItems = ctx.vars[op.totalItems] as number | undefined;
  if (!totalItems) return undefined;
  return Math.ceil(totalItems / op.perPage);
};
