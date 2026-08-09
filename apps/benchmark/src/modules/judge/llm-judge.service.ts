import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import {
  LoadedScenario,
  ResolvedSubtreeCase,
} from "../scenario/scenario.types";
import { CandidateAggregate } from "../execution/candidate-aggregate.types";
import { PhaseInput } from "../input/input.types";
import { LlmCallGate } from "../concurrency/llm-call-gate.service";

// ─── Result shape ────────────────────────────────────────────────────────────

export interface JudgeCandidateScore {
  candidateId: string;
  scores: Record<string, number>;
  rationale: string;
}

export interface JudgeVerdict {
  /** Label of the subtree this verdict was rendered against. */
  subtreeLabel: string;
  candidates: JudgeCandidateScore[];
  /** "best=<id>" | "tie" | "none-acceptable". */
  verdict: string;
  cost: number;
  model: string;
  rawContent: string;
  parsed: unknown;
}

// ─── JSON schema for the judge response (OpenAI dialect) ─────────────────────

const JUDGE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          scores: {
            type: "object",
            // free-form key/value scores so the judge can structure however the
            // scenario instructs. Each value must be a number.
            additionalProperties: { type: "number" },
          },
          rationale: { type: "string" },
        },
        required: ["candidateId", "scores", "rationale"],
        additionalProperties: false,
      },
    },
    verdict: { type: "string" },
  },
  required: ["candidates", "verdict"],
  additionalProperties: false,
} as const;

@Injectable()
export class LlmJudgeService {
  private readonly logger = new CustomLogger(LlmJudgeService.name);

  constructor(
    private readonly aiChat: AiChatService,
    private readonly gate: LlmCallGate,
  ) {}

  /**
   * Run a single judge call scoped to one subtree. The judge sees the
   * subtree-specific desiredOutcome (per-case override or scenario-level
   * fallback) and golden output. Returns undefined when the judge is
   * disabled or no candidate produced a successful run on this subtree.
   */
  async judge(
    loaded: LoadedScenario,
    subtreeCase: ResolvedSubtreeCase,
    input: PhaseInput,
    aggregates: CandidateAggregate[],
    renderedSubtree: string,
  ): Promise<JudgeVerdict | undefined> {
    const judgeSpec = loaded.scenario.judge;
    if (!judgeSpec || !judgeSpec.enabled) return undefined;

    // Floor: at least one candidate must have at least one successful run.
    const judgeable = aggregates.filter((a) => a.reliability.successes > 0);
    if (judgeable.length === 0) {
      this.logger.warn(
        `Skipping judge for ${subtreeCase.label}: no candidate produced a successful run.`,
      );
      return undefined;
    }

    const systemPrompt = this.buildSystemPrompt(judgeSpec.instructions);
    const userPrompt = this.buildUserPrompt(
      loaded,
      subtreeCase,
      input,
      aggregates,
      renderedSubtree,
    );

    let tracedCost = 0;
    try {
      const response = await this.gate.run(() =>
        this.aiChat.createChat({
          model: judgeSpec.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: judgeSpec.model.startsWith("gpt-5") ? 1 : 0.2,
          schema: JUDGE_RESPONSE_SCHEMA,
          schemaName: "benchmark_judge_verdict",
          costLabel: `benchmark:judge:${loaded.scenario.id}:${subtreeCase.label}`,
          traceCollector: (data) => {
            tracedCost = data.cost;
          },
        }),
      );

      const parsed = response.parsed as
        | { candidates: JudgeCandidateScore[]; verdict: string }
        | undefined;
      if (!parsed) {
        this.logger.warn(
          `Judge for ${subtreeCase.label} returned no parsed output`,
        );
        return undefined;
      }

      return {
        subtreeLabel: subtreeCase.label,
        candidates: parsed.candidates,
        verdict: parsed.verdict,
        cost: response.cost ?? tracedCost ?? 0,
        model: response.model,
        rawContent: response.content,
        parsed,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Judge call for ${subtreeCase.label} failed: ${message}`,
      );
      return undefined;
    }
  }

  // ─── Prompt assembly ───────────────────────────────────────────────────────

  private buildSystemPrompt(instructions: string): string {
    return [
      "You are an evaluation judge for prompt-engineering experiments.",
      "You will see a scenario description, the desired outcome, the input the candidates worked on, and the outputs each candidate produced.",
      "Compare candidates faithfully against the desired outcome.",
      "When a reference (golden) output is included, treat it as guidance — deviations are not automatically wrong, but you should explain them in your rationale.",
      'Return a single JSON object matching the schema. Verdict format: "best=<candidateId>", "tie", or "none-acceptable".',
      "",
      "Scenario-specific scoring instructions:",
      instructions,
    ].join("\n");
  }

  private buildUserPrompt(
    loaded: LoadedScenario,
    subtreeCase: ResolvedSubtreeCase,
    input: PhaseInput,
    aggregates: CandidateAggregate[],
    renderedSubtree: string,
  ): string {
    const parts: string[] = [];

    parts.push(`# Scenario: ${loaded.scenario.id}`);
    parts.push(loaded.scenario.description);
    parts.push("");
    parts.push(`## Subtree: ${subtreeCase.label}`);
    parts.push("");
    parts.push("## Desired outcome");
    parts.push(subtreeCase.expectations.desiredOutcome);
    parts.push("");
    parts.push("## Input subtree");
    parts.push("```");
    parts.push(renderedSubtree);
    parts.push("```");

    const goldenMeta = subtreeCase.goldenOutputMeta;
    const goldenOutput = subtreeCase.goldenOutput;
    if (goldenOutput !== undefined && goldenMeta) {
      const role = goldenMeta.role;
      const note = goldenMeta.note;
      parts.push("");
      parts.push(
        `## Reference output (hand-curated, role="${role}", treat as guidance, not as a hard target)`,
      );
      if (note) parts.push(`Note: ${note}`);
      parts.push("```json");
      parts.push(JSON.stringify(goldenOutput, null, 2));
      parts.push("```");
    }

    parts.push("");
    parts.push("## Candidates");
    for (const aggregate of aggregates) {
      parts.push("");
      parts.push(`### Candidate: ${aggregate.candidateId}`);
      const reliability = aggregate.reliability;
      parts.push(
        `- runs: ${reliability.totalRuns}, successes: ${reliability.successes}/${reliability.totalRuns}, cost mean: $${aggregate.cost.mean.toFixed(6)} (±${(aggregate.cost.max - aggregate.cost.min).toFixed(6)})`,
      );
      const rep = aggregate.runs[aggregate.representativeRunIndex];
      if (rep) {
        parts.push(
          `- Representative run (index=${rep.runIndex}) parsed output:`,
        );
        parts.push("```json");
        parts.push(
          rep.parsed === undefined
            ? "(no parsed output — failure: " +
                (rep.failureMessage ?? "unknown") +
                ")"
            : JSON.stringify(rep.parsed, null, 2),
        );
        parts.push("```");
      }
      if (reliability.failures.total > 0) {
        const reasons = Object.entries(reliability.failures.byReason)
          .filter(([, count]) => count > 0)
          .map(([reason, count]) => `${reason}: ${count}`)
          .join(", ");
        parts.push(`- failures: ${reasons}`);
      }
    }

    parts.push("");
    parts.push("Now produce the JSON verdict.");

    return parts.join("\n");
  }
}
