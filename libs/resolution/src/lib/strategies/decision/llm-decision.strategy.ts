import { Injectable } from "@nestjs/common";
import { AiChatService } from "@ebike-backend/ai";
import { ChatTraceData } from "@ebike-backend/debug";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { CustomLogger } from "@ebike-backend/logger";
import { sortBy } from "lodash";
import type { DecisionStrategy } from "../../models/strategy-types";
import type {
  FinalDecision,
  ResolutionContext,
} from "../../models/resolution-context";
import type { SlimCandidate, SlimReference } from "../../models/slim-types";
import type { ResolutionThreadContext } from "../../models/caller-context";
import { MatchingConfigService } from "../../matching/matching-config.service";

const DEFAULT_MAX_PICKS = 6;
const DEFAULT_DECISION_MODEL = "deepseek-v4-flash";
const MAX_CANDIDATE_SPECS = 8;
const PARENT_COMMENT_TRUNCATE = 400;
const COMMENT_BODY_TRUNCATE = 500;

interface RawDecisionResponse {
  picks: Array<{ candidateId: string; confidence: number; reason: string }>;
  evidenceSummary: string;
}

/**
 * Decision LLM strategy. Resolves ONE `ProductReference` to ONE OR MORE
 * catalog candidates. Returns 0..N picks (cap configurable via
 * `resolution.matching.maxLlmPicks`, default 6).
 *
 * Multi-pick fires when a single mention is genuinely ambiguous about which
 * catalog SKU it points to:
 *   - Generic mention matching multiple SKUs ("M3 Pro" → "M3 Pro 14" + "M3 Pro 16").
 *   - Regional variants ("LG 32GS95" → -B for NA + -W for EU).
 *   - Sibling SKUs the comment doesn't differentiate further.
 *
 * Multi-product comments are extraction's domain — each distinct product mention
 * gets its own `ProductReference` upstream and resolves independently.
 *
 * Uses the matcher's mode-aware accept threshold (`matching.acceptThreshold` /
 * `acceptThresholdStrict`) as the per-pick gate. Picks below the threshold are
 * dropped; if none survive, returns `llm_unresolved/below_accept_threshold`.
 *
 * Candidate IDs in the prompt are short tokens (`c1`, `c2`, …) mapped back to
 * real productIds at parse time. Reduces prompt tokens and lowers the chance
 * of UUID-shaped hallucinations.
 */
@Injectable()
export class LlmDecisionStrategy implements DecisionStrategy {
  private readonly logger = new CustomLogger(LlmDecisionStrategy.name);

  constructor(
    private readonly aiChatService: AiChatService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly matchingConfig: MatchingConfigService,
  ) {}

  async decide(
    context: ResolutionContext,
    threadContext?: ResolutionThreadContext,
    traceCollector?: (data: ChatTraceData) => void,
    logContext?: Record<string, string>,
  ): Promise<FinalDecision> {
    const candidates = context.candidates;

    if (candidates.length === 0) {
      return {
        kind: "llm_unresolved",
        confidence: 0,
        reason: "no_qualifying_candidates",
        selectedCandidates: [],
        evidenceSummary: "pre-filter dropped every candidate",
      };
    }

    const maxPicks =
      this.dynamicConfigService.resolution?.matching?.maxLlmPicks ??
      DEFAULT_MAX_PICKS;
    const matchingCfg = this.matchingConfig.config;
    const acceptThreshold =
      context.options.mode === "strict"
        ? matchingCfg.acceptThresholdStrict
        : matchingCfg.acceptThreshold;

    // Build a short-id map for the prompt. Candidates are already sorted by
    // matcher score desc on the context (scoring stage re-sorts), so c1 is the
    // matcher's top pick. Map is local to this call — never leaks.
    const orderedCandidates = candidates;
    const shortIdByReal = new Map<string, string>();
    const realByShort = new Map<string, string>();
    orderedCandidates.forEach((candidate, index) => {
      const short = `c${index + 1}`;
      shortIdByReal.set(candidate.productId, short);
      realByShort.set(short, candidate.productId);
    });

    const schema = buildSchema(maxPicks);
    const systemPrompt = buildSystemPrompt(maxPicks);
    const userMessage = this.buildUserMessage(
      context,
      threadContext,
      shortIdByReal,
    );
    const model =
      this.dynamicConfigService.search?.decisionModel ?? DEFAULT_DECISION_MODEL;

    let raw: RawDecisionResponse;
    try {
      const response = await this.aiChatService.createChat({
        costLabel: "product_resolution_decision",
        schema,
        schemaName: "product_resolution_decision",
        traceCollector,
        logContext,
        threadId: context.threadId,
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 1,
      });
      raw = JSON.parse(
        response.choices[0].message.content ?? "{}",
      ) as RawDecisionResponse;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "llm_unresolved",
        confidence: 0,
        reason: "decision_llm_error",
        selectedCandidates: [],
        evidenceSummary: `decision LLM error: ${message}`,
      };
    }

    // Reverse-map short ids → real productIds. Drop hallucinated picks
    // (short id not in the map; the LLM made one up).
    const mappedPicks = (raw.picks ?? [])
      .map((pick) => {
        const realId = realByShort.get(pick.candidateId);
        if (!realId) {
          this.logger.warn("Decision LLM returned unknown candidate short id", {
            shortId: pick.candidateId,
            ...logContext,
          });
          return undefined;
        }
        return {
          candidateId: realId,
          confidence: pick.confidence,
          reason: pick.reason,
        };
      })
      .filter(
        (
          pick,
        ): pick is {
          candidateId: string;
          confidence: number;
          reason: string;
        } => pick !== undefined,
      );

    // Empty picks → unresolved. Distinguish "LLM said none fit" (no picks at
    // all) from "all the evidence was family-level" (SERP without catalog hits).
    if (mappedPicks.length === 0) {
      const familyOnly =
        context.searchEvidence.length > 0 &&
        context.searchEvidence.every(
          (evidence) => evidence.resolvedProducts.length === 0,
        );
      return {
        kind: "llm_unresolved",
        confidence: 0,
        reason: familyOnly ? "family_only_evidence" : "llm_returned_none",
        selectedCandidates: [],
        evidenceSummary: raw.evidenceSummary,
      };
    }

    // Per-pick accept-threshold gate. Hard gate — sub-threshold picks are
    // discarded. The matcher's accept floor is the single source of truth so
    // both matcher and LLM paths produce candidates with confidence ≥ floor.
    const accepted = mappedPicks.filter(
      (pick) => pick.confidence >= acceptThreshold,
    );

    if (accepted.length === 0) {
      return {
        kind: "llm_unresolved",
        confidence: Math.max(...mappedPicks.map((p) => p.confidence)),
        reason: "below_accept_threshold",
        selectedCandidates: [],
        evidenceSummary: raw.evidenceSummary,
      };
    }

    const sorted = sortBy(accepted, (pick) => -pick.confidence);
    return {
      kind: "llm_resolved",
      confidence: sorted[0].confidence,
      reason: "llm_resolved",
      selectedCandidates: sorted,
      evidenceSummary: raw.evidenceSummary,
    };
  }

  private buildUserMessage(
    context: ResolutionContext,
    threadContext: ResolutionThreadContext | undefined,
    shortIdByReal: Map<string, string>,
  ): string {
    const input = context.input;
    const lines: string[] = [];

    // ── Product to Identify ────────────────────────────────────────────────
    lines.push("## Product to Identify");
    lines.push(`Brand: ${input.brand ?? "unknown"}`);
    lines.push(`Model: ${input.model ?? "unknown"}`);
    if (input.displayName) lines.push(`As mentioned: ${input.displayName}`);
    if (input.modelClues?.length)
      lines.push(`Model clues: ${input.modelClues.join(", ")}`);
    if (input.variantClues?.length)
      lines.push(`Variant clues: ${input.variantClues.join(", ")}`);
    if (input.specs?.length) {
      lines.push(
        `Extracted specs: ${input.specs
          .map((spec) => `${spec.name}=${spec.value}`)
          .join(", ")}`,
      );
    }
    lines.push("");

    // ── Reference Product (variant-search case) ────────────────────────────
    if (context.referenceProduct) {
      const ref = context.referenceProduct;
      lines.push("## Reference Product");
      lines.push(
        "The mention is a back-reference or sibling of a product already identified",
      );
      lines.push(
        "elsewhere in the thread. Pick a SIBLING SKU when the comment cues differ",
      );
      lines.push(
        "from the reference; pick the SAME SKU when the comment cues match exactly.",
      );
      lines.push(`Brand: ${ref.brand ?? "unknown"}`);
      lines.push(`Model: ${ref.model ?? "unknown"}`);
      if (ref.productCategory)
        lines.push(`Category: ${ref.productCategory.name}`);
      const refSpecs = renderSpecs(ref.specs);
      if (refSpecs) lines.push(`Reference specs: ${refSpecs}`);
      lines.push("");
    }

    // ── Comment Body ──────────────────────────────────────────────────────
    if (threadContext?.commentBody) {
      lines.push("## Comment Body");
      lines.push(threadContext.commentBody.slice(0, COMMENT_BODY_TRUNCATE));
      lines.push("");
    }

    // ── Grandparent / Parent Comments (top-down conversational order) ──────
    if (threadContext?.grandparentCommentBody) {
      lines.push("## Grandparent Comment");
      lines.push(
        threadContext.grandparentCommentBody.slice(0, PARENT_COMMENT_TRUNCATE),
      );
      lines.push("");
    }
    if (threadContext?.parentCommentBody) {
      lines.push("## Parent Comment (direct reply target)");
      lines.push(
        threadContext.parentCommentBody.slice(0, PARENT_COMMENT_TRUNCATE),
      );
      lines.push("");
    }

    // ── Thread Context ────────────────────────────────────────────────────
    if (threadContext) {
      lines.push("## Thread Context");
      lines.push(`Subreddit: r/${threadContext.subreddit}`);
      lines.push(`Thread title: ${threadContext.threadTitle}`);
      if (threadContext.opSummary)
        lines.push(`OP summary: ${threadContext.opSummary}`);
      if (threadContext.resolvedProducts?.length) {
        lines.push(
          `Other resolved products in thread: ${threadContext.resolvedProducts.join(", ")}`,
        );
      }
      lines.push("");
    }

    // ── Web Search Evidence ───────────────────────────────────────────────
    if (context.searchEvidence.length > 0) {
      lines.push("## Web Search Evidence");
      for (const evidence of context.searchEvidence.slice(0, 20)) {
        lines.push(`- [${evidence.queryIntent}] ${evidence.title}`);
        if (evidence.description) lines.push(`  ${evidence.description}`);
        lines.push(`  ${evidence.url}`);
        if (evidence.modelNumbers.length > 0) {
          lines.push(`  models in text: ${evidence.modelNumbers.join(", ")}`);
        }
        if (evidence.resolvedProducts.length > 0) {
          lines.push(
            `  → catalog: ${evidence.resolvedProducts.map((p) => `${p.brand} ${p.model}`).join(", ")}`,
          );
        }
      }
      lines.push("");
    }

    // ── Matcher Diagnostics (soft evidence) ───────────────────────────────
    if (context.scoring) {
      const parts: string[] = [];
      if (context.scoring.normalizedInput) {
        parts.push(`normalized input: "${context.scoring.normalizedInput}"`);
      }
      if (context.scoring.bestCandidate) {
        parts.push(
          `matcher best: ${context.scoring.bestCandidate.alias} (score ${context.scoring.bestCandidate.score})`,
        );
      }
      if (context.scoring.secondScore != null) {
        parts.push(`runner-up score: ${context.scoring.secondScore}`);
      }
      if (context.scoring.failedGates?.length) {
        parts.push(`failed gates: ${context.scoring.failedGates.join(", ")}`);
      }
      if (parts.length > 0) {
        lines.push(
          "## Matcher Diagnostics (soft evidence — do not enforce as constraints)",
        );
        for (const part of parts) lines.push(`- ${part}`);
        lines.push("");
      }
    }

    // ── Qualifying Candidates ─────────────────────────────────────────────
    lines.push("## Qualifying Candidates");
    lines.push(
      "Each candidate has already passed required spec and category gates.",
    );
    lines.push(
      "Pick from the candidates that match THIS specific mention. If more than one plausibly matches (regional variant, sibling SKU), include all that fit.",
    );
    lines.push("");
    for (const candidate of context.candidates) {
      const shortId =
        shortIdByReal.get(candidate.productId) ?? candidate.productId;
      lines.push(`- ${formatCandidate(candidate, shortId)}`);
    }

    return lines.join("\n");
  }
}

function buildSchema(maxPicks: number) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      picks: {
        type: "array",
        minItems: 0,
        maxItems: maxPicks,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            candidateId: { type: "string" },
            confidence: { type: "integer", minimum: 0, maximum: 100 },
            reason: { type: "string" },
          },
          required: ["candidateId", "confidence", "reason"],
        },
      },
      evidenceSummary: { type: "string" },
    },
    required: ["picks", "evidenceSummary"],
  } as const;
}

function buildSystemPrompt(maxPicks: number): string {
  return `You are a product identification expert. You are resolving ONE product mention (the "Product to Identify" below) to its catalog SKU(s). The comment may discuss many products — IGNORE everything except the specific mention named in "Product to Identify". Other mentions are handled separately by their own resolution call.

Given the mention's brand/model/clues, the comment body for context, thread context, web search evidence, and a list of qualifying catalog candidates, decide which catalog candidate(s) THIS one mention refers to.

Return an array \`picks\` of 0..${maxPicks} catalog candidates that THIS specific mention matches. Each pick carries:
- candidateId: the candidate's short id from the "Qualifying Candidates" list (e.g. "c1"). Must appear in the list — never invent one.
- confidence: 0..100 INTEGER. 0 = no confidence, 100 = certain.
- reason: 1 sentence citing the specific evidence that anchors this pick.

Multi-pick rules (when a SINGLE mention plausibly maps to MULTIPLE catalog SKUs):
- The mention is generic and matches multiple SKUs the comment doesn't disambiguate (e.g. mention = "M3 Pro", candidates include "M3 Pro 14" and "M3 Pro 16" with no size hint in the comment → pick both).
- The mention names a SKU that has regional equivalents in the catalog (e.g. mention = "LG 32GS95UE", candidates include "32GS95UE-B" and "32GS95UE-W"). Pick the regional variants the cross-market SERP evidence links together.
- Sibling SKUs that the comment cannot rule out — pick all that the brand + spec evidence supports.

When NOT to multi-pick:
- The mention names a specific SKU and one candidate matches it exactly — pick that one only, even if siblings are in the pool.
- A candidate's specs contradict the comment's evidence — exclude it.

When to return an empty \`picks\` array:
- No candidate fits the mention — even after the matcher and recall.
- The mention turned out to be a non-product (rare — extraction misclassification).

Per-pick rules:
- The comment body is the primary signal but is about more than just this mention. Read it for evidence that disambiguates THIS mention. Ignore parts of the comment that describe other products.
- SERP evidence carries weight only when its model numbers map back to a candidate.
- Use subreddit, thread title, and OP summary as context clues for the product family.
- Parent/grandparent comments (when present) provide the conversational context — the current comment may use referring language ("the same one", "the cheaper option") that only resolves when read against the parent.
- When a "## Reference Product" section is present, the mention is a sibling or variant of a product already identified in the thread. Use the reference's specs as the BASELINE; pick a sibling SKU when the comment cues differ from the reference (e.g. reference = "M3 Pro 14"; comment says "the 16-inch one" → pick the 16-inch sibling). Pick the SAME SKU when the comment matches the reference exactly.
- "matcher confidence" annotations on each candidate are evidence, not a constraint. A low matcher score warns that the literal name match was weak.
- evidenceSummary must cite the specific clues that drove the overall decision.

Cross-market reasoning:
- A SERP evidence record tagged \`cross_market\` was fetched specifically to find regional renames of the input mention.
- If a \`cross_market\` record's modelNumbers resolve (via "→ catalog") to one of the candidates, that candidate is likely the regional equivalent of the mention — pick it alongside the primary regional match.`;
}

function formatCandidate(candidate: SlimCandidate, shortId: string): string {
  const name =
    candidate.displayName ??
    `${candidate.brand ?? ""} ${candidate.model ?? ""}`.trim();
  const specs = renderSpecs(candidate.specs);
  const parts: string[] = [];
  if (candidate.matchScore != null) {
    const score = candidate.matchScore;
    const label = score < 50 ? "low" : score < 70 ? "moderate" : "high";
    parts.push(`matcher confidence: ${score} (${label})`);
  }
  const matcherNote = parts.length > 0 ? ` | ${parts.join("; ")}` : "";
  return `id=${shortId}: ${name}${specs ? ` | ${specs}` : ""}${matcherNote}`;
}

/** Render a ProductSpecs map as `key=value, key=value, ...` capped at
 *  MAX_CANDIDATE_SPECS. Skips empty/false values. */
function renderSpecs(
  specs: SlimReference["specs"] | SlimCandidate["specs"],
): string {
  if (!specs) return "";
  return Object.entries(specs)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    )
    .slice(0, MAX_CANDIDATE_SPECS)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}
