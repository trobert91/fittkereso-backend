// ─── Declarative scrape-pipeline operation vocabulary ──────────────────────
//
// A ScrapeOperation[] array is executed left-to-right by the interpreter in
// libs/scrape-interpreter against a shared execution context (Cheerio root,
// raw HTML, task, named `vars`, runtime data providers). Each op is a pure
// function of (context, previousValue, params) -> newValue, except for the
// small closed set of `runtime:*` data-source references.
//
// `{{varName}}` inside string-typed params (regex patterns, templates) is
// resolved against `vars` at execution time.

export type RuntimeDataSourceKey = 'brandCache' | 'brandNames' | 'categoryBySlug';

interface OpBase {
  as?: string; // store result under this name in `vars` in addition to passing it on
  on?: string; // read the input value from this `vars` entry instead of the pipeline's current value
}

// ─── Selection ───────────────────────────────────────────────────────────

export interface SelectAllOp extends OpBase {
  op: 'selectAll';
  selector: string;
  within?: string; // vars key holding a cheerio selection to scope the query to
}

export interface SelectFirstOp extends OpBase {
  op: 'selectFirst';
  selector: string;
  within?: string;
  onMissing?: 'throw' | 'returnEmpty';
}

export interface SelectTextOp extends OpBase {
  op: 'selectText';
  selector: string;
  first?: boolean;
  trim?: boolean;
}

export interface SelectAttrOp extends OpBase {
  op: 'selectAttr';
  selector: string;
  attr: string;
  first?: boolean;
  trim?: boolean;
}

export interface SelectNestedTextOp extends OpBase {
  op: 'selectNestedText';
  index: number;
  childSelector: string;
  trim?: boolean;
  fallback?: string;
}

export interface SelectSiblingContainerOp extends OpBase {
  op: 'selectSiblingContainer';
  untilSelector: string;
  filterSelector: string;
  first?: boolean;
}

// ─── String manipulation ─────────────────────────────────────────────────

export interface TrimOp extends OpBase {
  op: 'trim';
}

export interface TrimEndOp extends OpBase {
  op: 'trimEnd';
  chars: string;
}

export interface AppendSuffixOp extends OpBase {
  op: 'appendSuffix';
  value: string;
}

export interface StripPatternOp extends OpBase {
  op: 'stripPattern';
  value?: string; // vars key; defaults to current pipeline value
  pattern: string; // regex source, supports {{var}} interpolation
  flags?: string;
  trim?: boolean;
}

export interface StripPrefixOp extends OpBase {
  op: 'stripPrefix';
  value?: string;
  prefix: string; // supports {{var}} interpolation
  flags?: string;
}

export interface SplitAndTakeOp extends OpBase {
  op: 'splitAndTake';
  value?: string;
  separator: string;
  index: number;
  trim?: boolean;
}

export interface SplitAndSliceOp extends OpBase {
  op: 'splitAndSlice';
  value?: string;
  separator: string;
  skipFirst?: number;
}

export interface CoalesceOp extends OpBase {
  op: 'coalesce';
  candidates: string[]; // vars keys, first non-empty wins
}

export interface IdentityOp extends OpBase {
  op: 'identity';
  value?: string;
}

// ─── Regex ───────────────────────────────────────────────────────────────

export interface RegexCaptureOp extends OpBase {
  op: 'regexCapture';
  value?: string;
  pattern: string;
  group: number;
  cast?: 'number' | 'string';
  trim?: boolean;
}

export interface FindScriptContainingOp extends OpBase {
  op: 'findScriptContaining';
  contains: string;
}

// ─── Filtering / assertion ───────────────────────────────────────────────

export interface AssertContainsOp extends OpBase {
  op: 'assertContains';
  value?: string;
  substring: string;
  onFail: 'returnEmpty' | 'throw';
}

export interface FilterByNonEmptyOp extends OpBase {
  op: 'filterByNonEmpty';
  value?: string;
  onFail?: 'returnEmpty' | 'throw';
}

export interface FilterByAttrAbsentOp extends OpBase {
  op: 'filterByAttrAbsent';
  attr: string;
}

export interface FilterByAttrSuffixOp extends OpBase {
  op: 'filterByAttrSuffix';
  attr: string;
  excludeSuffix: string;
}

export interface FilterByAllowlistOp extends OpBase {
  op: 'filterByAllowlist';
  against: string; // e.g. "sourceTitles" — supplied by the caller via runtime opts
  caseInsensitive?: boolean;
  dedupeBy?: string;
}

export interface FilterOutEqualsIgnoreCaseOp extends OpBase {
  op: 'filterOutEqualsIgnoreCase';
  against: string; // vars key
}

export interface FilterByCategoryYearSuffixOp extends OpBase {
  op: 'filterByCategoryYearSuffix';
  yearsBack: number;
  includeCurrentYear?: boolean;
}

export interface DedupeOp extends OpBase {
  op: 'dedupe';
}

export interface TakeFirstOp extends OpBase {
  op: 'takeFirst';
  count: number;
}

export interface IsEmptyConditionOp extends OpBase {
  op: 'isEmpty';
  value?: string;
}

// ─── Link / pagination extraction ────────────────────────────────────────

export interface ExtractLinkTitlePairsOp extends OpBase {
  op: 'extractLinkTitlePairs';
  titleFromOwnTextExcludingChildren?: boolean;
  resolveRelativeAgainst?: string;
}

export interface ExtractLinkFromBoxOp extends OpBase {
  op: 'extractLinkFromBox';
  linkSelector: string;
  excludeHrefContains?: string;
  first?: boolean;
  urlTransform?: ScrapeOperation[];
  titleFrom?: Array<`attr:${string}` | 'text'>;
  titleTransform?: ScrapeOperation[];
  titleTemplate?: string;
  categoryFrom?: string;
}

export interface MatchAgainstRuntimeListOp extends OpBase {
  op: 'matchAgainstRuntimeList';
  source: `runtime:${RuntimeDataSourceKey}`;
  field: string;
  caseInsensitive?: boolean;
}

export interface FilterByBrandPrefixOp extends OpBase {
  op: 'filterByBrandPrefix';
  source: `runtime:${RuntimeDataSourceKey}`;
  field: string;
  caseInsensitive?: boolean;
}

export interface GeneratePaginationLinksOp extends OpBase {
  op: 'generatePaginationLinks';
  totalPages: string; // vars key
  startPage: number;
  baseUrl: string; // vars key
  urlTemplate: string; // supports {baseUrl}/{page} placeholders
  titleTemplate: string;
}

export interface BuildBaseUrlOp extends OpBase {
  op: 'buildBaseUrl';
  from: 'task.url';
  stripQuery?: boolean;
  trimTrailingSlash?: boolean;
}

export interface ComputePagesOp extends OpBase {
  op: 'computePages';
  totalItems: string; // vars key
  perPage: number;
}

// ─── Spec-table extraction ───────────────────────────────────────────────

export interface ExtractSpecTableV1Op extends OpBase {
  op: 'extractSpecTableV1';
  rowSelector: string;
  // Selector for a section-header marker relative to the name cell (e.g.
  // "h3") — if found inside the name cell, the row is a section divider
  // rather than a spec row.
  sectionHeaderSelector: string;
  nameSelector: string;
  nameExcludeChildren?: boolean;
  valueCellIndex: number;
  listValueSelector: string;
  descriptionSelector: string;
  descriptionAttr: string;
  dedupeBy: 'name';
}

export interface ExtractSpecTableV2Op extends OpBase {
  op: 'extractSpecTableV2';
  rowSelector: string;
  sectionHeaderRowClass: string;
  nameSelector: string;
  descriptionSelector: string;
  descriptionAttr: string;
  valueContainerSelector: string;
  valueIconFallback?: { selector: string; attr: string };
  dedupeBy: 'name';
}

export interface ExtractSpecTableBySectionOp extends OpBase {
  op: 'extractSpecTableBySection';
  sectionTitleSelector: string;
  tableSelector: string;
  tableRelation: 'nextAll';
  tableFirst?: boolean;
  rowSelector: string;
  minCells: number;
  nameCellIndex: number;
  nameExcludeChildren?: string;
  descriptionCellIndex: number;
  descriptionSelector: string;
  valueCellIndex: number;
  splitValueOn: string;
  htmlAware?: boolean;
}

export interface AppendSyntheticSpecOp extends OpBase {
  op: 'appendSyntheticSpec';
  name: string;
  value: ScrapeOperation[];
}

// ─── Image extraction ─────────────────────────────────────────────────────

export interface ExtractAttrListOp extends OpBase {
  op: 'extractAttrList';
  attr: string;
  trim?: boolean;
}

export interface ExtractImageWithFallbackOp extends OpBase {
  op: 'extractImageWithFallback';
  primary: { selector: string; attr: string; mustContain?: string };
  fallback: {
    selector: string;
    attr: string;
    mustContain?: string;
    replacePatterns?: Array<{ from: string; to: string }>;
  };
}

// ─── Value mapping (delegates to ProductValueMapperService) ──────────────

export interface MapSpecValueOp extends OpBase {
  op: 'mapSpecValue';
  label: string;
  single: boolean;
  cast?: 'number';
}

// ─── Control flow ─────────────────────────────────────────────────────────

export interface BranchCondition {
  selectorExists?: string;
  isEmpty?: string; // vars key
}

export interface BranchOp extends OpBase {
  op: 'branch';
  condition: BranchCondition;
  ifTrue: ScrapeOperation[];
  ifFalse: ScrapeOperation[];
}

export type ScrapeOperation =
  | SelectAllOp
  | SelectFirstOp
  | SelectTextOp
  | SelectAttrOp
  | SelectNestedTextOp
  | SelectSiblingContainerOp
  | TrimOp
  | TrimEndOp
  | AppendSuffixOp
  | StripPatternOp
  | StripPrefixOp
  | SplitAndTakeOp
  | SplitAndSliceOp
  | CoalesceOp
  | IdentityOp
  | RegexCaptureOp
  | FindScriptContainingOp
  | AssertContainsOp
  | FilterByNonEmptyOp
  | FilterByAttrAbsentOp
  | FilterByAttrSuffixOp
  | FilterByAllowlistOp
  | FilterOutEqualsIgnoreCaseOp
  | FilterByCategoryYearSuffixOp
  | DedupeOp
  | TakeFirstOp
  | IsEmptyConditionOp
  | ExtractLinkTitlePairsOp
  | ExtractLinkFromBoxOp
  | MatchAgainstRuntimeListOp
  | FilterByBrandPrefixOp
  | GeneratePaginationLinksOp
  | BuildBaseUrlOp
  | ComputePagesOp
  | ExtractSpecTableV1Op
  | ExtractSpecTableV2Op
  | ExtractSpecTableBySectionOp
  | AppendSyntheticSpecOp
  | ExtractAttrListOp
  | ExtractImageWithFallbackOp
  | MapSpecValueOp
  | BranchOp;

// ─── Category slug resolution rules ────────────────────────────────────────

export type CategoryLookupCondition =
  | { equalsIgnoreCase: string }
  | { specValueIncludes: { label: string; anyOf: string[] } }
  | { specSectionTitleIn: string[] }
  | { always: true };

export interface CategoryLookupRule {
  when: CategoryLookupCondition;
  slug: string;
  unless?: CategoryLookupCondition;
}
