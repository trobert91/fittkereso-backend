import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import {
  EXTRACTION_JSON_SCHEMA,
  PromptAssemblyService,
  ThreadCategoryConfig,
  ThreadContext,
} from "@ebike-backend/thread-processor";
import { ResolvedCandidate } from "../scenario/scenario.types";
import { PhaseInput } from "../input/input.types";
import {
  CandidateRunResult,
  PhaseRunner,
  PhaseRunnerOptions,
  RunFailureReason,
} from "./phase-runner.interface";
import { LlmCallGate } from "../concurrency/llm-call-gate.service";

/**
 * Extraction phase runner — Phase 4 in the production pipeline.
 *
 * Builds the same prompts `SubtreeExtractionService` builds (via
 * `PromptAssemblyService.buildExtractionPrompt`), then calls the LLM via
 * `AiChatService.createChat` with the extraction JSON schema for structured
 * output.
 *
 * The user prompt is assembled deterministically by `PromptAssemblyService`
 * and includes:
 *   - cheat sheet (`context.cheatSheetString`)
 *   - OP section (`context.opSection`) for non-OP subtrees
 *   - resolved products section (per-PLAN-comment with real DB-style specs)
 *   - rendered subtree with [PLAN]/[CONTEXT] nodes (and [products: ...]
 *     annotations from the prior identification step)
 *
 * What's swappable per candidate:
 *   - the system prompt (when `candidate.systemPromptSource = { file }`,
 *     the file contents replace the system prompt entirely)
 *   - the model
 *   - the temperature (gpt-5* still forced to 1)
 *   - cheat sheet (`cheatSheetOverride`)
 *   - OP section (`opSectionOverride`)
 *   - category configs (`categoryConfigOverride`) — drives both the system
 *     prompt's scope section and the focus filter
 *   - extraction options (`extractionOptionsOverride`) — per-candidate
 *     overrides to maxFocusCategories, stripContext, etc.
 *
 * What is NOT swappable: the user prompt body assembly. It is always built by
 * `PromptAssemblyService` so the deterministic structure (PLAN/CONTEXT
 * classification, resolved-products section, comment annotations) matches
 * production.
 */
@Injectable()
export class ExtractionPhaseRunner implements PhaseRunner {
  readonly phase = "extraction" as const;
  private readonly logger = new CustomLogger(ExtractionPhaseRunner.name);

  constructor(
    private readonly aiChat: AiChatService,
    private readonly promptAssembly: PromptAssemblyService,
    private readonly gate: LlmCallGate,
  ) {}

  buildPrompts(
    input: PhaseInput,
    candidate: ResolvedCandidate,
  ): { systemPrompt: string; userPrompt: string } {
    const effectiveContext = this.applyContextOverrides(
      input.context,
      candidate,
    );
    const focusConfigs = this.resolveFocusConfigs(
      effectiveContext,
      candidate,
      input.extras.maxFocusCategories,
    );
    const stripContext =
      candidate.extractionOptionsOverride?.stripContext ??
      input.extras.stripContext ??
      true;

    const assembled = this.promptAssembly.buildExtractionPrompt(
      input.subtree,
      effectiveContext,
      focusConfigs,
      {
        planProductAnnotations: input.extras.planProductAnnotations,
        stripContext,
      },
    );
    const systemPrompt =
      candidate.resolvedSystemPromptText ?? assembled.systemPrompt;
    return { systemPrompt, userPrompt: assembled.userPrompt };
  }

  async run(
    input: PhaseInput,
    candidate: ResolvedCandidate,
    runIndex: number,
    options: PhaseRunnerOptions,
  ): Promise<CandidateRunResult> {
    const { systemPrompt, userPrompt } = this.buildPrompts(input, candidate);

    const isGpt5 = candidate.model.startsWith("gpt-5");
    const temperature = isGpt5 ? 1 : (candidate.temperature ?? 1);

    const startTime = Date.now();
    const baseResult: Omit<
      CandidateRunResult,
      | "rawContent"
      | "parsed"
      | "schemaValid"
      | "schemaErrors"
      | "cost"
      | "usage"
      | "executionTimeInSec"
      | "succeeded"
    > = {
      candidateId: candidate.id,
      runIndex,
      model: candidate.model,
      systemPrompt,
      userPrompt,
    };

    let tracedCost = 0;
    try {
      const response = await this.gate.run(() =>
        this.aiChat.createChat({
          model: candidate.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature,
          schema: EXTRACTION_JSON_SCHEMA,
          schemaName: "subtree_extraction",
          costLabel: this.costLabelPrefix(
            options.scenarioId,
            options.subtreeLabel,
            candidate.id,
            runIndex,
          ),
          traceCollector: (data) => {
            tracedCost = data.cost;
          },
        }),
      );

      const executionTimeInSec = (Date.now() - startTime) / 1000;
      const finishReason = response.finishReason;
      const rawContent = response.content;

      const empty =
        rawContent === undefined || rawContent === null || rawContent === "";
      const truncated =
        finishReason !== undefined &&
        finishReason !== "stop" &&
        finishReason !== "end_turn";

      let failureReason: RunFailureReason | undefined;
      let failureMessage: string | undefined;
      let schemaValid = true;
      const schemaErrors: string[] = [];

      if (empty || truncated) {
        failureReason = "emptyOrTruncated";
        failureMessage = empty
          ? "response content was empty"
          : `response was truncated: finishReason=${finishReason}`;
        schemaValid = false;
      } else if (response.parsed === undefined) {
        try {
          JSON.parse(rawContent);
          failureReason = "schemaInvalid";
          failureMessage = "schema validation produced no parsed output";
          schemaValid = false;
          schemaErrors.push(failureMessage);
        } catch (parseError: unknown) {
          failureReason = "notJsonParseable";
          failureMessage =
            parseError instanceof Error
              ? parseError.message
              : String(parseError);
          schemaValid = false;
          schemaErrors.push(failureMessage);
        }
      }

      const result: CandidateRunResult = {
        ...baseResult,
        rawContent,
        parsed: response.parsed,
        schemaValid,
        schemaErrors,
        cost: response.cost ?? tracedCost ?? 0,
        usage: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          cachedTokens: response.usage.cachedTokens,
        },
        executionTimeInSec,
        succeeded: failureReason === undefined,
        failureReason,
        failureMessage,
      };

      return result;
    } catch (error: unknown) {
      const executionTimeInSec = (Date.now() - startTime) / 1000;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Candidate ${candidate.id} run ${runIndex} failed: ${message}`,
      );
      return {
        ...baseResult,
        rawContent: "",
        parsed: undefined,
        schemaValid: false,
        schemaErrors: [],
        cost: tracedCost,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
        },
        executionTimeInSec,
        succeeded: false,
        failureReason: "providerError",
        failureMessage: message,
      };
    }
  }

  costLabelPrefix(
    scenarioId: string,
    subtreeLabel: string,
    candidateId: string,
    runIndex: number,
  ): string {
    return `benchmark:${scenarioId}:${subtreeLabel}:${candidateId}:${runIndex}`;
  }

  // ─── Override resolution ───────────────────────────────────────────────────

  /**
   * Apply per-candidate cheatSheet/opSection overrides by cloning the context.
   * Identity is preserved when no overrides apply so the base context is
   * shared across candidates and across the runner / report rendering paths.
   */
  private applyContextOverrides(
    source: ThreadContext,
    candidate: ResolvedCandidate,
  ): ThreadContext {
    const hasCheatSheet = candidate.cheatSheetOverride !== undefined;
    const hasOp = candidate.opSectionOverride !== undefined;
    if (!hasCheatSheet && !hasOp) return source;

    const clone = Object.create(
      Object.getPrototypeOf(source) as object,
    ) as ThreadContext;
    Object.assign(clone, source);
    if (hasCheatSheet) clone.cheatSheetString = candidate.cheatSheetOverride;
    if (hasOp) clone.opSection = candidate.opSectionOverride;
    return clone;
  }

  /**
   * Resolve focus configs in the same precedence order the production extraction
   * service uses: explicit candidate override → top-N slice of context configs.
   * `maxFocusCategories` from the fixture extras serves as the default N.
   */
  private resolveFocusConfigs(
    context: ThreadContext,
    candidate: ResolvedCandidate,
    extrasMaxFocus: number | undefined,
  ): ThreadCategoryConfig[] {
    if (candidate.categoryConfigOverride !== undefined) {
      return candidate.categoryConfigOverride as ThreadCategoryConfig[];
    }
    const max =
      candidate.extractionOptionsOverride?.maxFocusCategories ??
      extrasMaxFocus ??
      1;
    return context.categoryConfigs.slice(0, max);
  }
}
