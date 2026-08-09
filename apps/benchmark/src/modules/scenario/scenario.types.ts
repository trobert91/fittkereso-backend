// ─── Scenario file shapes ────────────────────────────────────────────────────
// These types mirror the JSON-on-disk format. They are the contract a scenario
// author writes against and a coding agent generates.

export type Phase =
  | 'identification'
  | 'extraction'
  | 'labeling'
  | 'validation'
  | 'op-summary'
  | 'disambiguation';

export interface RunsConfig {
  perCandidate: number;
  /**
   * Hard cap on simultaneous in-flight LLM calls across the WHOLE scenario
   * (candidate runs + judge calls). Subtrees, candidates, and runs all fan out
   * in parallel; this gate is what actually throttles the request rate. Default 4.
   *
   * Setting this higher (e.g. 8 or 16) is the main lever for cutting wall-clock
   * time on multi-subtree scenarios. Watch out for provider rate limits —
   * deepseek tolerates 10+ parallel requests; OpenAI/Anthropic less so.
   */
  maxInFlight?: number;
  /**
   * @deprecated Use `maxInFlight`. Kept on the type so legacy scenarios still
   * parse; ignored at runtime with a warning logged at scenario load.
   */
  concurrency?: number;
  stopOnSchemaErrorRate?: number;
}

export type SubtreeMode = 'extraction' | 'validation';

/**
 * One subtree case within a multi-subtree scenario. Carries optional per-case
 * overrides for expectations and golden output that replace (not merge with)
 * the scenario-level defaults.
 */
export interface SubtreeCase {
  /** Index into the subtree map (0 = OP, 1..N = content) for real-thread input. For fixtures: index into fixture.subtrees array. */
  index: number;
  /** Optional human label shown in the report and in cost labels. Defaults to `subtree-<index>`. */
  label?: string;
  /** Per-subtree override — replaces (not merges with) scenario-level expectations. */
  expectations?: ExpectationsSpec;
  /** Per-subtree override — replaces scenario-level judge.goldenOutput. */
  judge?: { goldenOutput?: JudgeGoldenOutput };
}

/**
 * Either 'all' (sugar for "every subtree the builder produces") or an explicit
 * list of cases. The loader normalizes both forms into a `SubtreeCase[]` for
 * the runner.
 */
export type SubtreeSelection = 'all' | SubtreeCase[];

/**
 * Optional per-scenario override of `SubtreeBuilderService` packing knobs.
 * Any field omitted falls back to the hardcoded benchmark defaults
 * (softBudget=6000, hardBudget=10000, maxPlanNodes=15, maxDepth=8). Use this
 * to A/B builder behavior — e.g. comparing maxPlanNodes 10 vs 15 against the
 * same thread.
 */
export interface SubtreeBuilderOverride {
  softBudget?: number;
  hardBudget?: number;
  maxPlanNodes?: number;
  maxDepth?: number;
}

export interface RealThreadInput {
  kind: 'real-thread';
  threadId: string;
  mode: SubtreeMode;
  /** Multi-subtree selection. When omitted, falls back to legacy `subtreeIndex`. */
  subtrees?: SubtreeSelection;
  /** Legacy single-subtree pointer. Synthesized into `subtrees: [{ index: subtreeIndex }]` at load time. */
  subtreeIndex?: number;
  /** Optional override for the comment-tree staleness window, in seconds. */
  maxFetchAgeSec?: number;
  /** Optional override of SubtreeBuilder packing knobs. */
  subtreeBuilder?: SubtreeBuilderOverride;
}

export interface FixtureInput {
  kind: 'fixture';
  /** Path resolved relative to the scenario file. */
  path: string;
  /**
   * Multi-subtree selection. When omitted, falls back to: (a) every subtree in
   * the fixture's `subtrees` array (multi-subtree fixture), or (b) the single
   * `subtree` block (legacy single-subtree fixture).
   */
  subtrees?: SubtreeSelection;
}

export type ScenarioInput = RealThreadInput | FixtureInput;

/**
 * One entry in the `inputs` array — a named input source. The `id` is a short
 * slug used as a grouping key in the report and as a golden-file lookup key.
 * All other fields match the underlying `ScenarioInput` shape.
 *
 * A per-input `goldenOutput` takes precedence over `judge.goldenOutput` for
 * subtree cases that come from this input.
 */
export type InputSpec = { id: string; goldenOutput?: JudgeGoldenOutput; /** When false, this input is skipped. Default: true. */ enabled?: boolean } & ScenarioInput;

export type SystemPromptSource = 'current' | { file: string };
export type UserPromptSource = 'current';

export interface CandidateSpec {
  id: string;
  model: string;
  systemPromptSource: SystemPromptSource;
  /** When false, this candidate is skipped. Default: true. */
  enabled?: boolean;
  userPromptSource?: UserPromptSource;
  /** When set, replaces the category configs derived from the thread. */
  categoryConfigOverride?: unknown;
  /** Per-candidate temperature override. gpt-5* models will still be forced to 1. */
  temperature?: number;
  /**
   * Per-candidate cheat sheet override — replaces `context.cheatSheetString`
   * for this candidate only. Useful for A/B comparing prompt sensitivity to
   * cheat sheet content. Default: fixture's `cheatSheet`.
   */
  cheatSheetOverride?: string;
  /**
   * Per-candidate OP section override — replaces `context.opSection` for this
   * candidate only. Default: fixture's `opSummary`.
   */
  opSectionOverride?: string;
  /**
   * Extraction-specific knobs. Each field overrides the matching field on the
   * fixture's `extractionOptions` block. Ignored by phases other than
   * extraction.
   */
  extractionOptionsOverride?: ExtractionOptionsOverride;
}

/**
 * Knobs that drive how `PromptAssemblyService.buildExtractionPrompt` and the
 * downstream validation behave. Mirrors the fields on
 * `SubtreeExtractionService.ExtractionOptions` that affect prompt shape.
 */
export interface ExtractionOptionsOverride {
  maxFocusCategories?: number;
  maxQuotesCeiling?: number;
  validSpecNames?: string[];
  /** When true (default), CONTEXT nodes are stripped from the rendered tree. */
  stripContext?: boolean;
}

export type MustCheck =
  | { kind: 'regex'; pattern: string; appliesTo?: 'rawContent' | 'stringifiedParsed' }
  | { kind: 'substring'; value: string; appliesTo?: 'rawContent' | 'stringifiedParsed' }
  | { kind: 'productMention'; brand: string; model: string };

export interface ExpectationsSpec {
  desiredOutcome: string;
  mustContain?: MustCheck[];
  mustNotContain?: MustCheck[];
  /**
   * Schema id used to validate the parsed output. Currently supported:
   *   - 'subtree-identification.schema'
   *   - 'subtree-extraction.schema'
   *   - 'quote-labeling.schema'
   */
  schemaCheck?: string;
}

export interface JudgeGoldenOutput {
  /** Path resolved relative to the scenario file. */
  path: string;
  role: 'reference' | 'ideal';
  note?: string;
}

export interface JudgeSpec {
  enabled: boolean;
  model: string;
  instructions: string;
  /** When false, judge is given the representative run + variance summary; when true, judge scores every run. */
  perRun?: boolean;
  goldenOutput?: JudgeGoldenOutput;
}

export type ReportFormat = 'markdown' | 'html';

/**
 * One expected validation issue. Used by the benchmark report to compute which
 * seeded mistakes each candidate missed and surface that programmatically (no
 * judge call required). The benchmark matches a seed against a candidate's
 * `parsed.refs[]` by walking each ref's resolvedProducts entry — the rendered
 * refLabel is matched back to the comment via the prompt's label-to-comment
 * map, then issue type is checked.
 *
 * Validation-phase only.
 */
export interface ExpectedIssueSeed {
  /** PLAN comment's externalId (matches fixture node externalId). */
  commentExternalId: string;
  /** Issue type the LLM is expected to emit (must be one of LLM_EMITTABLE_TYPES). */
  expectedIssueType: string;
  /** Optional human note shown in the report. */
  note?: string;
}

export interface Scenario {
  id: string;
  phase: Phase;
  description: string;
  runs: RunsConfig;
  /**
   * Which report formats to write. Defaults to ['markdown'] when omitted.
   * Use ['markdown', 'html'] to get both. 'html' produces a self-contained
   * single-file report with collapsible sections and syntax-highlighted JSON.
   */
  reportFormats?: ReportFormat[];
  /**
   * @deprecated Use `inputs`. Kept for backward compatibility; normalised to
   * `inputs: [{ id: 'default', ...input }]` at load time.
   */
  input?: ScenarioInput;
  /**
   * Array of named input sources. Each entry is processed independently and
   * produces its own subtree cases tagged with the entry's `id`. The report
   * groups subtrees by input id. Use this to run one scenario across multiple
   * threads or fixtures without merging them into a single fixture file.
   */
  inputs?: InputSpec[];
  candidates: CandidateSpec[];
  expectations: ExpectationsSpec;
  judge?: JudgeSpec;
  /**
   * Validation-phase only. List of seeded mistakes the fixture introduces so
   * the report can compute per-subtree and scenario-wide miss lists without an
   * LLM judge call. Ignored for non-validation phases.
   */
  seedManifest?: ExpectedIssueSeed[];
}

// ─── Loaded scenario (paths resolved + candidate prompt files read in) ───────

export interface ResolvedCandidate extends CandidateSpec {
  resolvedSystemPromptText?: string; // populated when systemPromptSource is { file: ... }
}

/**
 * A single subtree case after loader normalization: per-case expectations
 * resolved (with scenario-level fallback applied), per-case golden loaded
 * from disk if any. The runner sees `subtreeCases` and never has to think
 * about the scenario/file fallback chain again.
 *
 * For fixtures, `index` always maps directly to the case's position in the
 * subtree-list inside the fixture file.
 *
 * For real-thread inputs with `subtrees: 'all'`, the loader emits an
 * `expandAll: true` sentinel case (with `index: -1`); the InputProvider
 * expands it lazily once the subtree map is built. For `subtrees: [{...}]`,
 * `expandAll` is false and `index` is the explicit case index.
 */
export interface ResolvedSubtreeCase {
  index: number;
  label: string;
  /** Which input entry this case came from. 'default' for backward-compat single-input scenarios. */
  inputId: string;
  /** When true (real-thread + 'all' sugar), the InputProvider expands this into one case per built subtree. */
  expandAll: boolean;
  expectations: ExpectationsSpec;
  goldenOutput?: unknown;
  goldenOutputMeta?: JudgeGoldenOutput;
}

/**
 * One resolved input entry — the named input spec plus its resolved subtree
 * cases (with golden loaded, expectations resolved, inputId stamped).
 */
export interface ResolvedInputEntry {
  inputId: string;
  input: InputSpec;
  subtreeCases: ResolvedSubtreeCase[];
}

export interface LoadedScenario {
  scenario: Scenario;
  /** Absolute path of the source scenario file. Used to resolve relative paths. */
  sourcePath: string;
  candidates: ResolvedCandidate[];
  /** Per-input entries — length matches inputs array (always >= 1). */
  inputEntries: ResolvedInputEntry[];
  /** Flat view of all subtree cases across all inputs — backward-compat shortcut for callers that don't care about input grouping. */
  subtreeCases: ResolvedSubtreeCase[];
}
