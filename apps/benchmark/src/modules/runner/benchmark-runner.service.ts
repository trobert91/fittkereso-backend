import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import {
  PromptAssemblyService,
  ValidationSubtreeRenderer,
  buildCommentLabelMap,
} from "@ebike-backend/thread-processor";
import { ScenarioLoader } from "../scenario/scenario-loader.service";
import { LoadedScenario, Phase } from "../scenario/scenario.types";
import { InputProviderService } from "../input/input-provider.service";
import { PhaseRunner } from "../phases/phase-runner.interface";
import { IdentificationPhaseRunner } from "../phases/identification-phase.runner";
import { ExtractionPhaseRunner } from "../phases/extraction-phase.runner";
import { LabelingPhaseRunner } from "../phases/labeling-phase.runner";
import { ValidationPhaseRunner } from "../phases/validation-phase.runner";
import { CandidateExecutor } from "../execution/candidate-executor.service";
import { LlmJudgeService } from "../judge/llm-judge.service";
import {
  CostAnalyzerService,
  SubtreeReportInput,
} from "../cost/cost-analyzer.service";
import {
  ReportPayload,
  ReportWriterService,
  SubtreeReportSection,
} from "../report/report-writer.service";
import {
  buildScenarioSeedSummary,
  buildSubtreeSeedAnalysis,
} from "../report/seed-analysis";
import { CliArgs } from "../../cli";
import { ResolvedPhaseCase } from "../input/input.types";
import { LlmCallGate } from "../concurrency/llm-call-gate.service";

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtSec(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m${String(remSec).padStart(2, "0")}s`;
}

/**
 * Emit a structured progress event on stdout. One line per event; greppable
 * via `^BENCH > ` prefix. Goes through console.log (not the logger) so it
 * bypasses level filters and timestamps and survives redirection cleanly.
 */
function emitProgress(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const payload = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  // eslint-disable-next-line no-console
  console.log(`BENCH > ${event}${payload ? " " + payload : ""}`);
}

/**
 * Per-scenario progress tracker. Emits scenario start/done plus a single
 * `progress` line each time the candidate-completion percentage crosses a
 * 20% milestone (20 / 40 / 60 / 80 / 100). Per-subtree and per-candidate
 * events are suppressed — they were too noisy to follow.
 */
class ProgressTracker {
  private static readonly MILESTONE_STEP = 0.2;
  private startMs = 0;
  private totalCandidateSlots = 0;
  private completedCandidates = 0;
  private spentUsd = 0;
  private nextMilestone = ProgressTracker.MILESTONE_STEP;

  start(opts: {
    scenarioId: string;
    phase: string;
    subtrees: number;
    candidates: number;
    runsPerCandidate: number;
    maxInFlight: number;
    judge: "on" | "off";
    gate: LlmCallGate;
  }): void {
    this.startMs = Date.now();
    this.totalCandidateSlots = opts.subtrees * opts.candidates;
    this.completedCandidates = 0;
    this.spentUsd = 0;
    this.nextMilestone = ProgressTracker.MILESTONE_STEP;

    const totalCalls = opts.subtrees * opts.candidates * opts.runsPerCandidate;
    emitProgress("scenario.start", {
      id: opts.scenarioId,
      phase: opts.phase,
      subtrees: opts.subtrees,
      candidates: opts.candidates,
      runsPerCandidate: opts.runsPerCandidate,
      totalCalls,
      maxInFlight: opts.maxInFlight,
      judge: opts.judge,
    });
  }

  candidateDone(opts: { meanCost: number; runs: number }): void {
    this.completedCandidates++;
    this.spentUsd += opts.meanCost * opts.runs;
    this.maybeEmitMilestone();
  }

  done(scenarioId: string, totalCostUsd: number, reportPath: string): void {
    emitProgress("scenario.done", {
      id: scenarioId,
      durationSec: fmtSec(Date.now() - this.startMs),
      totalCost: fmtUsd(totalCostUsd),
      reportPath,
    });
  }

  private maybeEmitMilestone(): void {
    if (this.totalCandidateSlots === 0) return;
    const fraction = this.completedCandidates / this.totalCandidateSlots;
    // Emit each 20% threshold at most once. Fire on any tick that's >= the
    // next pending milestone — handles bursts where multiple completions
    // land between checks (the gate releases several at once).
    while (
      this.nextMilestone <= 1.000001 &&
      fraction >= this.nextMilestone - 1e-9
    ) {
      const pct = Math.round(this.nextMilestone * 100);
      emitProgress("progress", {
        done: `${this.completedCandidates}/${this.totalCandidateSlots}`,
        pct: `${pct}%`,
        cost: fmtUsd(this.spentUsd),
        elapsed: fmtSec(Date.now() - this.startMs),
      });
      this.nextMilestone += ProgressTracker.MILESTONE_STEP;
    }
  }
}

/**
 * Top-level orchestrator. Picks one or more scenarios, drives them through
 * input → execution → judge → cost analysis → report. Returns a process exit
 * code so main.ts can propagate.
 *
 * Multi-subtree flow per scenario:
 *   1. Load thread / fixture, expand `'all'` sentinel into concrete cases.
 *   2. Configure the global `LlmCallGate` (semaphore) with `runs.maxInFlight`
 *      permits — this is the only thing throttling actual HTTP request rate.
 *   3. Fan out all subtrees in parallel. Within each subtree, fan out all
 *      candidates in parallel. Within each candidate, fan out all N runs in
 *      parallel. The gate caps total concurrent calls.
 *   4. After the parallel work settles, sort the per-subtree results back
 *      into the original index order so the report is deterministic.
 *   5. Build scenario-level rollups (CostSummary, scenario aggregates, Pareto).
 *   6. Write one report per scenario.
 */
@Injectable()
export class BenchmarkRunner {
  private readonly logger = new CustomLogger(BenchmarkRunner.name);

  constructor(
    private readonly scenarioLoader: ScenarioLoader,
    private readonly inputProvider: InputProviderService,
    private readonly identificationRunner: IdentificationPhaseRunner,
    private readonly extractionRunner: ExtractionPhaseRunner,
    private readonly labelingRunner: LabelingPhaseRunner,
    private readonly validationRunner: ValidationPhaseRunner,
    private readonly executor: CandidateExecutor,
    private readonly judge: LlmJudgeService,
    private readonly costAnalyzer: CostAnalyzerService,
    private readonly reportWriter: ReportWriterService,
    private readonly promptAssembly: PromptAssemblyService,
    private readonly validationRenderer: ValidationSubtreeRenderer,
    private readonly gate: LlmCallGate,
  ) {}

  async run(args: CliArgs): Promise<number> {
    const scenarios = this.selectScenarios(args);
    if (scenarios.length === 0) {
      this.logger.warn("No scenarios matched the provided filters.");
      return 1;
    }

    let exitCode = 0;
    for (const loaded of scenarios) {
      try {
        await this.runScenario(loaded, args);
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        this.logger.error(`Scenario ${loaded.scenario.id} failed: ${message}`);
        exitCode = 1;
      }
    }
    return exitCode;
  }

  // ─── Per-scenario flow ─────────────────────────────────────────────────────

  private async runScenario(
    loaded: LoadedScenario,
    args: CliArgs,
  ): Promise<void> {
    const scenario = loaded.scenario;
    this.logger.log(`=== Scenario: ${scenario.id} (${scenario.phase}) ===`);

    const runner = this.resolveRunner(scenario.phase);

    const phaseCases = await this.inputProvider.build(loaded, {
      noFetch: args.noFetch,
    });

    if (phaseCases.length === 0) {
      throw new Error(
        `Scenario ${scenario.id} resolved to zero subtree cases — nothing to run.`,
      );
    }

    if (args.dryRun) {
      this.printDryRun(loaded, phaseCases, runner);
      return;
    }

    // Wall-clock start for the scenario. Surfaced in the report's "Run summary"
    // block so a reviewer can read latency and cost off the very first table.
    const scenarioStartMs = Date.now();

    // Configure the global gate. Default 4; deprecation warning if a legacy
    // scenario still sets `concurrency` (now ignored — the gate replaces it).
    if (scenario.runs.concurrency !== undefined) {
      this.logger.warn(
        `Scenario ${scenario.id}: 'runs.concurrency' is deprecated and ignored. Use 'runs.maxInFlight' to cap simultaneous in-flight LLM calls.`,
      );
    }
    const maxInFlight = scenario.runs.maxInFlight ?? 4;
    this.gate.configure(maxInFlight);

    const runsPerCandidate = args.runs ?? scenario.runs.perCandidate;
    const progress = new ProgressTracker();
    progress.start({
      scenarioId: scenario.id,
      phase: scenario.phase,
      subtrees: phaseCases.length,
      candidates: loaded.candidates.length,
      runsPerCandidate,
      maxInFlight,
      judge: args.noJudge ? "off" : "on",
      gate: this.gate,
    });

    // Fan out all subtrees in parallel; within each subtree fan out candidates
    // in parallel; within each candidate fan out runs in parallel. The gate is
    // the only request-rate throttle. The tracker emits scenario.start/done
    // and a single `progress` line at every 20% candidate-completion milestone.
    const settled = await Promise.all(
      phaseCases.map(async (phaseCase): Promise<SubtreeReportSection> => {
        const { case: subtreeCase, input } = phaseCase;

        const aggregates = await Promise.all(
          loaded.candidates.map(async (candidate) => {
            const aggregate = await this.executor.execute(
              runner,
              input,
              candidate,
              scenario,
              subtreeCase,
              args.runs,
            );
            progress.candidateDone({
              meanCost: aggregate.cost.mean,
              runs: aggregate.runs.length,
            });
            return aggregate;
          }),
        );

        // Render the input subtree once for both the judge prompt and the report.
        // Each phase has its own rendering convention:
        //   - labeling: `buildLabelingPrompt` (refs/quotes inlined, A/B/C labels)
        //   - validation: `ValidationSubtreeRenderer` ([VALIDATE] blocks with
        //     refs/quotes/evidence — exactly what the validation LLM sees)
        //   - identification/extraction: `buildCommentsSection` (no quotes)
        const renderedSubtree =
          scenario.phase === "labeling"
            ? this.promptAssembly.buildLabelingPrompt(
                input.subtree,
                input.context,
                buildCommentLabelMap(input.subtree),
              )
            : scenario.phase === "validation"
              ? this.validationRenderer.render(input.subtree).rendered
              : this.promptAssembly.buildCommentsSection(
                  input.subtree,
                  input.context,
                );
        // For extraction scenarios, also render the resolved-products section
        // so the report shows the exact list of products each candidate saw.
        const resolvedProductsRendered =
          scenario.phase === "extraction"
            ? this.promptAssembly.buildResolvedProductsSection(input.subtree)
            : undefined;

        const judgeVerdict = args.noJudge
          ? undefined
          : await this.judge.judge(
              loaded,
              subtreeCase,
              input,
              aggregates,
              renderedSubtree,
            );

        return {
          subtreeCase,
          subtreeId: input.subtree.id,
          inputId: phaseCase.case.inputId,
          isOpSubtree: input.subtree.isOpSubtree,
          nodeCount: input.subtree.nodes.length,
          planNodeCount: input.subtree.planNodes.length,
          renderedSubtree,
          resolvedProductsRendered,
          planComments: input.subtree.planNodes.map((node, index) => ({
            // Labeling phase uses comment letters (A, B, C, ...) to match the
            // labeling user prompt's `### Comment X` headings; identification
            // and extraction use c0, c1, ... to match their prompt convention.
            shortId:
              scenario.phase === "labeling"
                ? String.fromCharCode(65 + index)
                : `c${index}`,
            authorName: node.comment.authorName,
            depth: node.depth,
            body: node.comment.body.trim(),
          })),
          candidates: aggregates,
          judge: judgeVerdict,
          seedAnalysis:
            scenario.phase === "validation" && scenario.seedManifest
              ? buildSubtreeSeedAnalysis(
                  input.subtree,
                  aggregates,
                  scenario.seedManifest,
                  this.validationRenderer,
                )
              : undefined,
        };
      }),
    );

    // Promise.all preserves input order, so settled is already in phaseCases
    // order — the report is deterministic regardless of completion order.
    const subtreeReports: SubtreeReportSection[] = settled;

    // Scenario-level rollups.
    const costInputs: SubtreeReportInput[] = subtreeReports.map((r) => ({
      subtreeCase: r.subtreeCase,
      aggregates: r.candidates,
      judge: r.judge,
    }));
    const costSummary = this.costAnalyzer.buildCostSummary(
      scenario.id,
      costInputs,
    );
    const candidatesAggregate =
      this.costAnalyzer.buildCandidateScenarioAggregates(costInputs);
    const pareto = this.costAnalyzer.buildPareto(candidatesAggregate);

    const seedSummary =
      scenario.phase === "validation" && scenario.seedManifest
        ? buildScenarioSeedSummary(
            scenario.seedManifest,
            loaded.candidates.map((c) => c.id),
            subtreeReports,
          )
        : undefined;

    const payload: ReportPayload = {
      scenarioId: scenario.id,
      scenario,
      subtrees: subtreeReports,
      candidatesAggregate,
      costSummary,
      pareto,
      durationMs: Date.now() - scenarioStartMs,
      seedSummary,
    };

    const written = this.reportWriter.write(loaded, payload);
    this.logger.log(`Report: ${written.primaryPath}`);

    progress.done(scenario.id, costSummary.totalUsd, written.primaryPath);
    this.printSummaryBlock(
      scenario.id,
      candidatesAggregate,
      pareto,
      costSummary,
      written.primaryPath,
    );
  }

  private printSummaryBlock(
    scenarioId: string,
    candidatesAggregate: ReturnType<
      CostAnalyzerService["buildCandidateScenarioAggregates"]
    >,
    pareto: ReturnType<CostAnalyzerService["buildPareto"]>,
    costSummary: ReturnType<CostAnalyzerService["buildCostSummary"]>,
    reportPath: string,
  ): void {
    const lines: string[] = [];
    lines.push("");
    lines.push(
      "═══════════════════════════════════════════════════════════════",
    );
    lines.push(`  Benchmark complete: ${scenarioId}`);
    lines.push(
      "═══════════════════════════════════════════════════════════════",
    );
    for (const c of candidatesAggregate) {
      const paretoEntry = pareto.find((p) => p.candidateId === c.candidateId);
      const dominated = paretoEntry?.dominatedBy
        ? ` (dominated by ${paretoEntry.dominatedBy})`
        : " (Pareto-optimal)";
      const judgeStr =
        c.judgeScore !== null
          ? `judge ${c.judgeScore.toFixed(2)}`
          : "judge n/a";
      const successPct = (c.successRate * 100).toFixed(0);
      lines.push(
        `  ${c.candidateId.padEnd(24)} ${judgeStr.padEnd(12)} ` +
          `success ${successPct}%  cost/run ${fmtUsd(c.cost.mean)}  total ${fmtUsd(c.cost.total)}${dominated}`,
      );
    }
    lines.push(
      "───────────────────────────────────────────────────────────────",
    );
    lines.push(
      `  Total: ${fmtUsd(costSummary.totalUsd)} (judge: ${fmtUsd(costSummary.judgeUsd)})`,
    );
    lines.push(`  Report: ${reportPath}`);
    lines.push(
      "═══════════════════════════════════════════════════════════════",
    );
    lines.push("");
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private selectScenarios(args: CliArgs): LoadedScenario[] {
    if (args.scenario) {
      return [this.scenarioLoader.loadById(args.scenario)];
    }
    if (args.suite) {
      return this.scenarioLoader.loadAll(args.phase as Phase | undefined);
    }
    return [];
  }

  private resolveRunner(phase: Phase): PhaseRunner {
    switch (phase) {
      case "identification":
        return this.identificationRunner;
      case "extraction":
        return this.extractionRunner;
      case "labeling":
        return this.labelingRunner;
      case "validation":
        return this.validationRunner;
      default:
        throw new Error(`Phase "${phase}" is not implemented yet.`);
    }
  }

  private printDryRun(
    loaded: LoadedScenario,
    phaseCases: ResolvedPhaseCase[],
    runner: PhaseRunner,
  ): void {
    // eslint-disable-next-line no-console
    console.log(
      `\n=== Dry-run for scenario "${loaded.scenario.id}" (${phaseCases.length} subtree case(s)) ===`,
    );
    for (const phaseCase of phaseCases) {
      // eslint-disable-next-line no-console
      console.log(
        `\n=== Subtree: ${phaseCase.case.label} (id=${phaseCase.input.subtree.id}) ===`,
      );
      for (const candidate of loaded.candidates) {
        const { systemPrompt, userPrompt } = runner.buildPrompts(
          phaseCase.input,
          candidate,
        );
        // eslint-disable-next-line no-console
        console.log(
          `\n--- Candidate: ${candidate.id} (model=${candidate.model}) ---`,
        );
        // eslint-disable-next-line no-console
        console.log("## SYSTEM PROMPT");
        // eslint-disable-next-line no-console
        console.log(systemPrompt);
        // eslint-disable-next-line no-console
        console.log("\n## USER PROMPT");
        // eslint-disable-next-line no-console
        console.log(userPrompt);
      }
    }
  }
}
