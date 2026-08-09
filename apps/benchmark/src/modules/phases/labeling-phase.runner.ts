import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import { IssueConfig } from "@ebike-backend/database";
import {
  buildLabelingJsonSchema,
  buildLabelingSystemPrompt,
  buildCommentLabelMap,
  PromptAssemblyService,
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
 * Labeling phase runner — Phase 4d in the production pipeline.
 *
 * Builds the same prompts `QuoteLabelingService` builds: system prompt via
 * `buildLabelingSystemPrompt`, user prompt via
 * `PromptAssemblyService.buildLabelingPrompt` (DFS-ordered comment tree
 * with refs/quotes inlined under each PLAN node). Then calls the LLM via
 * `AiChatService.createChat` with the labeling JSON schema for structured
 * output.
 *
 * What's swappable per candidate:
 *   - the system prompt (when `candidate.systemPromptSource = { file }`,
 *     the file contents replace the system prompt entirely)
 *   - the model
 *   - the temperature (production hardcodes 0; default here is 0; gpt-5*
 *     still forced to 1)
 *
 * What is NOT swappable: the user prompt. It is always assembled by
 * `PromptAssemblyService.buildLabelingPrompt` so the deterministic comment
 * tree + per-ref + per-quote layout matches production exactly.
 */
@Injectable()
export class LabelingPhaseRunner implements PhaseRunner {
  readonly phase = "labeling" as const;
  private readonly logger = new CustomLogger(LabelingPhaseRunner.name);

  constructor(
    private readonly aiChat: AiChatService,
    private readonly gate: LlmCallGate,
    private readonly promptAssembly: PromptAssemblyService,
  ) {}

  buildPrompts(
    input: PhaseInput,
    candidate: ResolvedCandidate,
  ): { systemPrompt: string; userPrompt: string } {
    const assembledSystemPrompt = buildLabelingSystemPrompt({
      categoryConfigs: input.context.categoryConfigs,
    });
    const commentLabelMap = buildCommentLabelMap(input.subtree);
    const userPrompt = this.promptAssembly.buildLabelingPrompt(
      input.subtree,
      input.context,
      commentLabelMap,
    );

    const systemPrompt =
      candidate.resolvedSystemPromptText ?? assembledSystemPrompt;
    return { systemPrompt, userPrompt };
  }

  async run(
    input: PhaseInput,
    candidate: ResolvedCandidate,
    runIndex: number,
    options: PhaseRunnerOptions,
  ): Promise<CandidateRunResult> {
    const { systemPrompt, userPrompt } = this.buildPrompts(input, candidate);

    const allowedIssueTypes = (
      input.context.categoryConfigs[0]?.issues ?? []
    ).map((issue: IssueConfig) => issue.label);

    const isGpt5 = candidate.model.startsWith("gpt-5");
    const temperature = isGpt5 ? 1 : (candidate.temperature ?? 0);

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
          schema: buildLabelingJsonSchema(allowedIssueTypes),
          schemaName: "quote_labeling",
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
}
