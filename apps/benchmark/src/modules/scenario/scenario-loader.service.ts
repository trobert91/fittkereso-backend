import { Injectable } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { isEmpty } from "lodash";
import { CustomLogger } from "@ebike-backend/logger";
import {
  CandidateSpec,
  ExpectationsSpec,
  InputSpec,
  JudgeGoldenOutput,
  LoadedScenario,
  Phase,
  ResolvedCandidate,
  ResolvedInputEntry,
  ResolvedSubtreeCase,
  Scenario,
  ScenarioInput,
  SubtreeCase,
} from "./scenario.types";

/**
 * Loads scenario JSON files from `apps/benchmark/scenarios/` and resolves any
 * referenced files (candidate system-prompt overrides, golden outputs).
 *
 * Normalizes the scenario into the multi-input/multi-subtree internal shape:
 * - `input` (singular, deprecated) is wrapped in `inputs: [{ id: 'default', ...input }]`
 * - `inputs` (array) is used as-is
 * Each input entry's subtree cases are resolved and tagged with the entry's
 * `inputId`. The loader exposes both `inputEntries` (grouped) and the flat
 * `subtreeCases` view (backward-compat shortcut).
 */
@Injectable()
export class ScenarioLoader {
  private readonly logger = new CustomLogger(ScenarioLoader.name);

  private readonly scenariosRoot = path.resolve(
    process.cwd(),
    "apps",
    "benchmark",
    "scenarios",
  );

  // ─── Public API ────────────────────────────────────────────────────────────

  loadById(scenarioId: string): LoadedScenario {
    const sourcePath = this.findScenarioPath(scenarioId);
    return this.loadFromPath(sourcePath);
  }

  loadAll(filterPhase?: Phase): LoadedScenario[] {
    const paths = this.findAllScenarioPaths();
    const loaded = paths.map((p) => this.loadFromPath(p));
    if (filterPhase) {
      return loaded.filter((l) => l.scenario.phase === filterPhase);
    }
    return loaded;
  }

  loadFromPath(sourcePath: string): LoadedScenario {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Scenario file not found: ${sourcePath}`);
    }
    const raw = fs.readFileSync(sourcePath, "utf8");
    let parsed: Scenario;
    try {
      parsed = JSON.parse(raw) as Scenario;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse scenario at ${sourcePath}: ${message}`);
    }

    this.validateShape(parsed, sourcePath);

    const scenarioDir = path.dirname(sourcePath);
    const enabledCandidates = parsed.candidates.filter((c) => {
      if (c.enabled === false) {
        this.logger.warn(
          `Scenario ${parsed.id}: candidate '${c.id}' is disabled — skipping.`,
        );
        return false;
      }
      return true;
    });
    const candidates = enabledCandidates.map((c) =>
      this.resolveCandidate(c, scenarioDir),
    );

    const normalizedInputs = this.normalizeInputs(parsed, sourcePath);
    const inputEntries: ResolvedInputEntry[] = normalizedInputs.map((spec) =>
      this.resolveInputEntry(parsed, spec, scenarioDir),
    );
    const subtreeCases = inputEntries.flatMap((e) => e.subtreeCases);

    this.logger.log(
      `Loaded scenario ${parsed.id} (phase=${parsed.phase}, candidates=${candidates.length}, inputs=${inputEntries.length}, subtreeCases=${this.describeSubtreeCases(subtreeCases)})`,
    );

    return {
      scenario: parsed,
      sourcePath,
      candidates,
      inputEntries,
      subtreeCases,
    };
  }

  // ─── Input normalization ───────────────────────────────────────────────────

  private normalizeInputs(scenario: Scenario, sourcePath: string): InputSpec[] {
    if (scenario.inputs && scenario.inputs.length > 0) {
      if (scenario.input) {
        this.logger.warn(
          `Scenario ${scenario.id}: both 'input' and 'inputs' present — 'inputs' takes precedence.`,
        );
      }
      const enabled = scenario.inputs.filter((input) => {
        if (input.enabled === false) {
          this.logger.warn(
            `Scenario ${scenario.id}: input '${input.id}' is disabled — skipping.`,
          );
          return false;
        }
        return true;
      });
      if (enabled.length === 0) {
        throw new Error(
          `Scenario at ${sourcePath}: all inputs are disabled — nothing to run.`,
        );
      }
      return enabled;
    }
    if (scenario.input) {
      return [{ id: "default", ...scenario.input }];
    }
    throw new Error(
      `Scenario at ${sourcePath}: must specify either 'inputs' (array) or 'input' (deprecated singular).`,
    );
  }

  // ─── Per-input entry resolution ────────────────────────────────────────────

  private resolveInputEntry(
    scenario: Scenario,
    spec: InputSpec,
    scenarioDir: string,
  ): ResolvedInputEntry {
    // Per-input golden takes precedence over the scenario-level judge golden.
    const effectiveGolden = spec.goldenOutput ?? scenario.judge?.goldenOutput;
    const cases = this.resolveSubtreeCasesForInput(
      scenario,
      spec,
      effectiveGolden,
      scenarioDir,
    );
    // Tag every case with the input id.
    const taggedCases = cases.map((c) => ({ ...c, inputId: spec.id }));
    return { inputId: spec.id, input: spec, subtreeCases: taggedCases };
  }

  /**
   * Resolve the subtree cases for a single input spec. Logic mirrors the
   * previous single-input `resolveSubtreeCases` exactly — the only difference
   * is that `input` comes from the spec argument rather than `scenario.input`.
   */
  private resolveSubtreeCasesForInput(
    scenario: Scenario,
    input: ScenarioInput,
    effectiveGolden: JudgeGoldenOutput | undefined,
    scenarioDir: string,
  ): ResolvedSubtreeCase[] {
    const scenarioExpectations = scenario.expectations;
    const explicit =
      input.kind === "real-thread" || input.kind === "fixture"
        ? input.subtrees
        : undefined;

    // 'all' or fixture without explicit subtrees → expandAll sentinel
    if (
      explicit === "all" ||
      (input.kind === "fixture" && explicit === undefined)
    ) {
      return [
        {
          index: -1,
          label: "all",
          inputId: "", // stamped by resolveInputEntry after this call
          expandAll: true,
          expectations: scenarioExpectations,
          goldenOutput: this.loadGoldenIfSet(
            effectiveGolden,
            scenarioDir,
            scenario.id,
          ),
          goldenOutputMeta: effectiveGolden,
        },
      ];
    }

    // Explicit SubtreeCase[]
    if (Array.isArray(explicit)) {
      if (explicit.length === 0) {
        throw new Error(
          `Scenario ${scenario.id}: input.subtrees array is empty (must contain at least one case)`,
        );
      }
      const seen = new Set<number>();
      return explicit.map((caseSpec) => {
        if (!Number.isInteger(caseSpec.index) || caseSpec.index < 0) {
          throw new Error(
            `Scenario ${scenario.id}: subtree case has invalid index (${caseSpec.index}) — must be a non-negative integer`,
          );
        }
        if (seen.has(caseSpec.index)) {
          throw new Error(
            `Scenario ${scenario.id}: duplicate subtree index ${caseSpec.index}`,
          );
        }
        seen.add(caseSpec.index);
        return this.buildResolvedCase(
          caseSpec,
          scenarioExpectations,
          effectiveGolden,
          scenarioDir,
          scenario.id,
        );
      });
    }

    // Legacy real-thread subtreeIndex
    if (input.kind === "real-thread" && Number.isInteger(input.subtreeIndex)) {
      return [
        {
          index: input.subtreeIndex as number,
          label: `subtree-${input.subtreeIndex}`,
          inputId: "",
          expandAll: false,
          expectations: scenarioExpectations,
          goldenOutput: this.loadGoldenIfSet(
            effectiveGolden,
            scenarioDir,
            scenario.id,
          ),
          goldenOutputMeta: effectiveGolden,
        },
      ];
    }

    throw new Error(
      `Scenario ${scenario.id}: input must specify either 'subtrees' (array or 'all') or legacy 'subtreeIndex'`,
    );
  }

  private buildResolvedCase(
    caseSpec: SubtreeCase,
    scenarioExpectations: ExpectationsSpec,
    scenarioGolden: JudgeGoldenOutput | undefined,
    scenarioDir: string,
    scenarioId: string,
  ): ResolvedSubtreeCase {
    const expectations = caseSpec.expectations ?? scenarioExpectations;
    const goldenMeta = caseSpec.judge?.goldenOutput ?? scenarioGolden;
    const goldenOutput = this.loadGoldenIfSet(
      goldenMeta,
      scenarioDir,
      scenarioId,
    );

    return {
      index: caseSpec.index,
      label: caseSpec.label ?? `subtree-${caseSpec.index}`,
      inputId: "", // stamped by resolveInputEntry after this call
      expandAll: false,
      expectations,
      goldenOutput,
      goldenOutputMeta: goldenMeta,
    };
  }

  private loadGoldenIfSet(
    spec: JudgeGoldenOutput | undefined,
    scenarioDir: string,
    scenarioId: string,
  ): unknown | undefined {
    if (!spec) return undefined;
    const goldenPath = path.resolve(scenarioDir, spec.path);
    if (!fs.existsSync(goldenPath)) {
      throw new Error(
        `Scenario ${scenarioId}: judge.goldenOutput.path not found: ${goldenPath}`,
      );
    }
    const goldenRaw = fs.readFileSync(goldenPath, "utf8");
    try {
      return JSON.parse(goldenRaw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Scenario ${scenarioId}: failed to parse goldenOutput JSON at ${goldenPath}: ${message}`,
      );
    }
  }

  private describeSubtreeCases(cases: ResolvedSubtreeCase[]): string {
    if (cases.length === 1 && cases[0].expandAll) return "all (expanded later)";
    return `${cases.length} (${cases.map((c) => c.label).join(", ")})`;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private resolveCandidate(
    spec: CandidateSpec,
    scenarioDir: string,
  ): ResolvedCandidate {
    if (spec.systemPromptSource === "current") {
      return { ...spec };
    }
    if (
      typeof spec.systemPromptSource === "object" &&
      "file" in spec.systemPromptSource
    ) {
      const promptPath = path.resolve(
        scenarioDir,
        spec.systemPromptSource.file,
      );
      if (!fs.existsSync(promptPath)) {
        throw new Error(
          `Candidate ${spec.id}: system prompt file not found: ${promptPath}`,
        );
      }
      const text = fs.readFileSync(promptPath, "utf8");
      return { ...spec, resolvedSystemPromptText: text };
    }
    throw new Error(
      `Candidate ${spec.id}: invalid systemPromptSource (expected 'current' or { file: ... })`,
    );
  }

  private validateShape(scenario: Scenario, sourcePath: string): void {
    const ctx = `scenario at ${sourcePath}`;
    if (isEmpty(scenario.id)) throw new Error(`${ctx}: missing 'id'`);
    if (isEmpty(scenario.phase)) throw new Error(`${ctx}: missing 'phase'`);
    if (!scenario.description) throw new Error(`${ctx}: missing 'description'`);
    if (!scenario.runs) throw new Error(`${ctx}: missing 'runs'`);
    if (
      !Number.isInteger(scenario.runs.perCandidate) ||
      scenario.runs.perCandidate < 1
    ) {
      throw new Error(`${ctx}: runs.perCandidate must be a positive integer`);
    }
    if (!scenario.input && (!scenario.inputs || scenario.inputs.length === 0)) {
      throw new Error(`${ctx}: missing 'inputs' (or deprecated 'input')`);
    }
    if (isEmpty(scenario.candidates)) {
      throw new Error(`${ctx}: 'candidates' must contain at least one entry`);
    }
    if (!scenario.expectations)
      throw new Error(`${ctx}: missing 'expectations'`);
  }

  private findScenarioPath(scenarioId: string): string {
    const matches = this.findAllScenarioPaths().filter(
      (p) => path.basename(p, ".scenario.json") === scenarioId,
    );
    if (matches.length === 0) {
      throw new Error(
        `No scenario file found for id "${scenarioId}" under ${this.scenariosRoot}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple scenario files match id "${scenarioId}": ${matches.join(", ")}`,
      );
    }
    return matches[0];
  }

  private findAllScenarioPaths(): string[] {
    if (!fs.existsSync(this.scenariosRoot)) {
      return [];
    }
    const results: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".scenario.json")) {
          results.push(full);
        }
      }
    };
    walk(this.scenariosRoot);
    return results;
  }
}
