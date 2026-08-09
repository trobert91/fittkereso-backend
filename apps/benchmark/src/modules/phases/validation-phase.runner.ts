import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import {
  LLM_VALIDATION_JSON_SCHEMA,
  ValidationSubtreeRenderer,
  buildValidationSystemPrompt,
  buildValidationUserPrompt,
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
 * Validation phase runner — Phase 5 in the production pipeline.
 *
 * Builds the same prompt SubtreeLlmIssueResolutionService builds: system
 * prompt from `buildValidationSystemPrompt({ categoryConfigs })`, user
 * prompt = `buildValidationUserPrompt` over the rendered subtree from
 * `ValidationSubtreeRenderer`. Calls the LLM with the validation JSON schema
 * for structured output. Production hardcodes `temperature: 1`; we mirror
 * that here.
 *
 * What's swappable per candidate:
 *   - the system prompt (when `candidate.systemPromptSource = { file }`,
 *     the file contents replace the system prompt entirely)
 *   - the model
 *   - the temperature (default 1 to match production; gpt-5* still forced to 1)
 *
 * What is NOT swappable: the user prompt. It is always assembled by
 * `ValidationSubtreeRenderer.render` so the rendered subtree the LLM sees
 * matches production byte-for-byte.
 */
@Injectable()
export class ValidationPhaseRunner implements PhaseRunner {
  readonly phase = "validation" as const;
  private readonly logger = new CustomLogger(ValidationPhaseRunner.name);

  constructor(
    private readonly aiChat: AiChatService,
    private readonly gate: LlmCallGate,
    private readonly renderer: ValidationSubtreeRenderer,
  ) {}

  buildPrompts(
    input: PhaseInput,
    candidate: ResolvedCandidate,
  ): { systemPrompt: string; userPrompt: string } {
    const { rendered } = this.renderer.render(input.subtree);
    const userPrompt = buildValidationUserPrompt(rendered);
    const builtSystemPrompt = buildValidationSystemPrompt({
      categoryConfigs: input.context.categoryConfigs,
    });
    const systemPrompt =
      candidate.resolvedSystemPromptText ?? builtSystemPrompt;
    return { systemPrompt, userPrompt };
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
          schema: LLM_VALIDATION_JSON_SCHEMA,
          schemaName: "llm_validation",
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
