import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import {
  selectAll,
  selectAttr,
  selectFirst,
  selectNestedText,
  selectSiblingContainer,
  selectText,
} from './selection-ops';
import {
  appendSuffix,
  coalesce,
  identity,
  literal,
  prependPrefix,
  splitAndSlice,
  splitAndTake,
  stripPattern,
  stripPrefix,
  trim,
  trimEnd,
  wrapInArray,
} from './string-ops';
import { findScriptContaining, regexCapture } from './regex-ops';
import { round } from './number-ops';
import {
  filterJsonArray,
  flattenJsonArray,
  mapJsonArray,
  parseJsonAttr,
} from './json-ops';
import {
  assertContains,
  dedupe,
  filterByAllowlist,
  filterByAttrAbsent,
  filterByAttrSuffix,
  filterByCategoryYearSuffix,
  filterByNonEmpty,
  filterOutEqualsIgnoreCase,
  isEmpty,
  takeFirst,
} from './filter-ops';
import {
  buildBaseUrl,
  computePages,
  extractLinkTitlePairs,
  filterByBrandPrefix,
  generatePaginationLinks,
  makeExtractLinkFromBox,
  matchAgainstRuntimeList,
} from './link-ops';
import {
  extractSpecTableBySection,
  extractSpecTableV1,
  extractSpecTableV2,
  makeAppendSyntheticSpec,
} from './spec-table-ops';
import {
  extractAttrList,
  extractImageWithFallback,
  extractTextList,
} from './image-ops';
import { makeMapSpecValue, mapValue } from './value-map-ops';
import { makeBranch } from './control-ops';
import { makeForEachItem } from './iteration-ops';
import { makeAssembleOffer } from './offer-ops';
import { jsonPath, makeAssembleListProduct } from './list-product-ops';

// Registers every op handler in the vocabulary. Ops that need to recursively
// run a sub-pipeline (branch, extractLinkFromBox, appendSyntheticSpec,
// forEachItem, assembleOffer) are built via factory functions closing over
// the runner; everything else is a stateless pure function.
export function registerOps(
  registry: ScrapeOpRegistryService,
  runner: ScrapePipelineRunnerService,
  valueMapper: ProductValueMapperService,
): void {
  registry.register('selectAll', selectAll);
  registry.register('selectFirst', selectFirst);
  registry.register('selectText', selectText);
  registry.register('selectAttr', selectAttr);
  registry.register('selectNestedText', selectNestedText);
  registry.register('selectSiblingContainer', selectSiblingContainer);

  registry.register('parseJsonAttr', parseJsonAttr);
  registry.register('mapJsonArray', mapJsonArray);
  registry.register('filterJsonArray', filterJsonArray);
  registry.register('flattenJsonArray', flattenJsonArray);

  registry.register('trim', trim);
  registry.register('trimEnd', trimEnd);
  registry.register('appendSuffix', appendSuffix);
  registry.register('prependPrefix', prependPrefix);
  registry.register('stripPattern', stripPattern);
  registry.register('round', round);
  registry.register('stripPrefix', stripPrefix);
  registry.register('splitAndTake', splitAndTake);
  registry.register('splitAndSlice', splitAndSlice);
  registry.register('coalesce', coalesce);
  registry.register('identity', identity);
  registry.register('literal', literal);
  registry.register('wrapInArray', wrapInArray);

  registry.register('regexCapture', regexCapture);
  registry.register('findScriptContaining', findScriptContaining);

  registry.register('assertContains', assertContains);
  registry.register('filterByNonEmpty', filterByNonEmpty);
  registry.register('filterByAttrAbsent', filterByAttrAbsent);
  registry.register('filterByAttrSuffix', filterByAttrSuffix);
  registry.register('filterByAllowlist', filterByAllowlist);
  registry.register('filterOutEqualsIgnoreCase', filterOutEqualsIgnoreCase);
  registry.register(
    'filterByCategoryYearSuffix',
    filterByCategoryYearSuffix,
  );
  registry.register('dedupe', dedupe);
  registry.register('takeFirst', takeFirst);
  registry.register('isEmpty', isEmpty);

  registry.register('extractLinkTitlePairs', extractLinkTitlePairs);
  registry.register('extractLinkFromBox', makeExtractLinkFromBox(runner));
  registry.register('matchAgainstRuntimeList', matchAgainstRuntimeList);
  registry.register('filterByBrandPrefix', filterByBrandPrefix);
  registry.register('generatePaginationLinks', generatePaginationLinks);
  registry.register('buildBaseUrl', buildBaseUrl);
  registry.register('computePages', computePages);

  registry.register('extractSpecTableV1', extractSpecTableV1);
  registry.register('extractSpecTableV2', extractSpecTableV2);
  registry.register('extractSpecTableBySection', extractSpecTableBySection);
  registry.register('appendSyntheticSpec', makeAppendSyntheticSpec(runner));

  registry.register('extractAttrList', extractAttrList);
  registry.register('extractTextList', extractTextList);
  registry.register('extractImageWithFallback', extractImageWithFallback);

  registry.register('mapSpecValue', makeMapSpecValue(valueMapper));
  registry.register('mapValue', mapValue);

  registry.register('branch', makeBranch(runner));

  registry.register('forEachItem', makeForEachItem(runner));
  registry.register('assembleOffer', makeAssembleOffer(runner));

  registry.register('jsonPath', jsonPath);
  registry.register(
    'assembleListProduct',
    makeAssembleListProduct(runner),
  );
}
