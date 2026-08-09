import { Injectable } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { CustomLogger } from "@ebike-backend/logger";
import {
  ExpectedIssueSeed,
  LoadedScenario,
  ResolvedSubtreeCase,
  Scenario,
} from "../scenario/scenario.types";
import { CandidateAggregate } from "../execution/candidate-aggregate.types";
import { JudgeVerdict } from "../judge/llm-judge.service";
import {
  CandidateScenarioAggregate,
  CostSummary,
  ParetoEntry,
} from "../cost/cost-analyzer.service";
import { MarkdownReportRenderer } from "./markdown-report-renderer";
import { HtmlReportRenderer } from "./html-report-renderer";

export interface PlanCommentSummary {
  /** Short id used in the prompt and schema response (c0, c1, ...). */
  shortId: string;
  /** Author handle as it appears in the prompt, when shown. */
  authorName?: string;
  /** Depth in the subtree. */
  depth: number;
  /** Comment body, trimmed of surrounding whitespace. */
  body: string;
}

/**
 * One per-subtree slice of the report. Mirrors the shape that used to be
 * `ReportPayload.input + ReportPayload.candidates + ReportPayload.judge`,
 * now repeated per subtree.
 */
export interface SubtreeReportSection {
  subtreeCase: ResolvedSubtreeCase;
  subtreeId: string;
  /** Which named input entry this subtree came from. 'default' for single-input scenarios. */
  inputId: string;
  isOpSubtree: boolean;
  nodeCount: number;
  planNodeCount: number;
  /** Comment section rendered by PromptAssemblyService — the exact text the LLM saw. */
  renderedSubtree: string;
  /**
   * Resolved-products section rendered by `PromptAssemblyService.buildResolvedProductsSection`.
   * Populated only for extraction-phase scenarios; identification scenarios leave it empty.
   */
  resolvedProductsRendered?: string;
  planComments: PlanCommentSummary[];
  /** Per-candidate aggregates — N runs of each candidate against this subtree. */
  candidates: CandidateAggregate[];
  /** Verdict from the judge call scoped to this subtree, or undefined. */
  judge?: JudgeVerdict;
  /**
   * Validation-phase only. The seeds this subtree is responsible for and how
   * each candidate fared on them. Computed deterministically from the
   * scenario's `seedManifest` and each candidate's representative-run output.
   */
  seedAnalysis?: SubtreeSeedAnalysis;
}

/** A seed expected to be flaggable in this subtree, with its rendered refLabel. */
export interface ExpectedSeedInSubtree extends ExpectedIssueSeed {
  /** The A/B/C... label rendered in the prompt for the comment carrying this seed. */
  refLabel: string;
}

/** Per-candidate result against a single expected seed. */
export interface CandidateSeedResult {
  candidateId: string;
  /** True iff the candidate's REPRESENTATIVE run emitted at least one issue with the expected `expectedIssueType` against the expected `refLabel`. */
  found: boolean;
  /** Issue types the representative run DID emit against this refLabel (for diagnostics). */
  emittedTypes: string[];
  /** How many of the candidate's runs flagged this seed correctly. */
  runFoundCount: number;
  /** How many runs the candidate executed for this subtree. */
  runTotal: number;
}

export interface SubtreeSeedAnalysis {
  /** Seeds whose comment is rendered in this subtree. May be empty. */
  expectedSeeds: ExpectedSeedInSubtree[];
  /**
   * Per-seed × per-candidate found/missed matrix. Outer index aligns with
   * `expectedSeeds`; inner array carries one entry per candidate in the order
   * candidates appear on `SubtreeReportSection.candidates`.
   */
  candidateResults: CandidateSeedResult[][];
}

export interface ReportPayload {
  scenarioId: string;
  scenario: Scenario;
  /** One section per subtree the scenario tested against. Always at least length 1. */
  subtrees: SubtreeReportSection[];
  /** Per-candidate scenario-level aggregates (rolled up across subtrees). */
  candidatesAggregate: CandidateScenarioAggregate[];
  costSummary: CostSummary;
  pareto: ParetoEntry[];
  /** Wall-clock duration of the scenario run in milliseconds. */
  durationMs: number;
  /**
   * Validation-phase only. Scenario-wide rollup of which seed manifest entries
   * each candidate flagged across all subtrees. Computed by aggregating each
   * subtree's `seedAnalysis`.
   */
  seedSummary?: ScenarioSeedSummary;
}

/** Per-candidate cell in the scenario-wide seed table. */
export interface ScenarioSeedCell {
  /** True iff the candidate's representative run flagged the seed. */
  repFound: boolean;
  /** How many of the candidate's runs flagged this seed. */
  runFoundCount: number;
  /** How many runs the candidate executed for the subtree carrying this seed. */
  runTotal: number;
}

/** One row in the scenario-wide seed table — a seed and which candidates found it. */
export interface ScenarioSeedRow {
  commentExternalId: string;
  expectedIssueType: string;
  note?: string;
  /** Subtree label (e.g. "subtree-3") where this seed was rendered. */
  subtreeLabel: string;
  refLabel: string;
  /** Map: candidateId → { repFound, runFoundCount, runTotal }. */
  byCandidate: Record<string, ScenarioSeedCell>;
}

export interface ScenarioSeedSummary {
  /** All seeds from `scenario.seedManifest`, with per-candidate found/missed. */
  rows: ScenarioSeedRow[];
  /**
   * Totals per candidate.
   *  - `found` / `missed`: representative-run rollup (one boolean per seed).
   *  - `runFound` / `runTotal`: cross-run rollup. `runTotal` = Σ over seeds of
   *    that seed's `runTotal` (i.e. each run of each seeded subtree counts once).
   *    `runFound` = Σ over seeds of `runFoundCount`. Use these to read "of the
   *    N total seeded-mistake opportunities across runs, the candidate caught X".
   */
  totals: Record<
    string,
    { found: number; missed: number; runFound: number; runTotal: number }
  >;
  /** Count of seeds that couldn't be matched to any rendered subtree (likely a fixture/manifest mismatch). */
  unmatchedSeedCount: number;
}

export interface WrittenReport {
  dir: string;
  jsonPath: string;
  /** Primary path shown in logs and progress output. Prefers HTML if enabled, else markdown. */
  primaryPath: string;
  mdPath?: string;
  htmlPath?: string;
}

@Injectable()
export class ReportWriterService {
  private readonly logger = new CustomLogger(ReportWriterService.name);

  private readonly runsRoot = path.resolve(
    process.cwd(),
    "apps",
    "benchmark",
    "runs",
  );

  private readonly markdownRenderer = new MarkdownReportRenderer();
  private readonly htmlRenderer = new HtmlReportRenderer();

  write(loaded: LoadedScenario, payload: ReportPayload): WrittenReport {
    if (!fs.existsSync(this.runsRoot)) {
      fs.mkdirSync(this.runsRoot, { recursive: true });
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    const dirName = `${stamp}-${payload.scenarioId}`;
    const dir = path.join(this.runsRoot, dirName);
    fs.mkdirSync(dir, { recursive: true });

    const jsonPath = path.join(dir, "report.json");
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

    const formats = loaded.scenario.reportFormats ?? ["markdown"];
    let mdPath: string | undefined;
    let htmlPath: string | undefined;

    if (formats.includes("markdown")) {
      mdPath = path.join(dir, "report.md");
      fs.writeFileSync(mdPath, this.markdownRenderer.render(payload), "utf8");
    }

    if (formats.includes("html")) {
      htmlPath = path.join(dir, "report.html");
      fs.writeFileSync(htmlPath, this.htmlRenderer.render(payload), "utf8");
    }

    const primaryPath = htmlPath ?? mdPath ?? jsonPath;

    this.logger.log(`Wrote report to ${dir}`);
    return { dir, jsonPath, primaryPath, mdPath, htmlPath };
  }
}
