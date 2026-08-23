import { Injectable } from '@nestjs/common';
import { AiChatService } from '@fittkereso-backend/ai';
import { ChatTraceData } from '@fittkereso-backend/debug';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { sortBy } from 'lodash';
import type { DecisionStrategy } from '../../models/strategy-types';
import type {
  FinalDecision,
  ResolutionContext,
} from '../../models/resolution-context';
import type { SlimCandidate } from '../../models/slim-types';
import { MatchingConfigService } from '../../matching/matching-config.service';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const MAX_CANDIDATES_CONSIDERED = 3;
const MAX_SPECS_RENDERED = 8;

interface RawMergeDecisionResponse {
  picks: Array<{ candidateId: string; confidence: number; reason: string }>;
  evidenceSummary: string;
}

/**
 * Scrape-time merge decision strategy. Answers a narrower, binary question
 * than `LlmDecisionStrategy`: "is this freshly-scraped product listing the
 * same physical product as this catalog candidate?" — not "which of these
 * candidates does this ambiguous mention refer to."
 *
 * Only reached when the matcher's quality gates already rejected the
 * candidate set (see `DecisionService`) — this strategy is the last chance to
 * accept a match before the scraper falls back to creating a new product.
 * Deliberately conservative: a wrong "yes" here attaches a scrape's offers to
 * the wrong existing catalog product, which is worse than the safe default
 * of creating a redundant new product.
 *
 * Unlike `LlmDecisionStrategy`, there is no web-search evidence on the scrape
 * path (`webSearchEnabled: false` throughout) and no multi-pick semantics — a
 * single scraped listing is exactly one product, so at most one candidate can
 * be accepted.
 */
@Injectable()
export class ScrapeMergeDecisionStrategy implements DecisionStrategy {
  private readonly logger = new CustomLogger(ScrapeMergeDecisionStrategy.name);

  constructor(
    private readonly aiChatService: AiChatService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly matchingConfig: MatchingConfigService,
  ) {}

  async decide(
    context: ResolutionContext,
    traceCollector?: (data: ChatTraceData) => void,
    logContext?: Record<string, string>,
  ): Promise<FinalDecision> {
    const candidates = sortBy(
      context.candidates,
      (c) => -(c.matchScore ?? 0),
    ).slice(0, MAX_CANDIDATES_CONSIDERED);

    if (candidates.length === 0) {
      return {
        kind: 'llm_unresolved',
        confidence: 0,
        reason: 'no_qualifying_candidates',
        selectedCandidates: [],
        evidenceSummary: 'no candidates to adjudicate',
      };
    }

    const matchingCfg = this.matchingConfig.config;
    const acceptThreshold =
      context.options.mode === 'strict'
        ? matchingCfg.acceptThresholdStrict
        : matchingCfg.acceptThreshold;

    const shortIdByReal = new Map<string, string>();
    const realByShort = new Map<string, string>();
    candidates.forEach((candidate, index) => {
      const short = `c${index + 1}`;
      shortIdByReal.set(candidate.productId, short);
      realByShort.set(short, candidate.productId);
    });

    const model =
      this.dynamicConfigService.search?.decisionModel ?? DEFAULT_MODEL;

    let raw: RawMergeDecisionResponse;
    try {
      const response = await this.aiChatService.createChat({
        costLabel: 'scrape-merge-decision',
        schema: buildSchema(),
        schemaName: 'scrape_merge_decision',
        traceCollector,
        logContext,
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: this.buildUserMessage(context, candidates, shortIdByReal),
          },
        ],
        temperature: 1,
      });
      raw = JSON.parse(
        response.choices[0].message.content ?? '{}',
      ) as RawMergeDecisionResponse;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Scrape merge decision LLM call failed', {
        error: message,
        ...logContext,
      });
      return {
        kind: 'llm_unresolved',
        confidence: 0,
        reason: 'decision_llm_error',
        selectedCandidates: [],
        evidenceSummary: `scrape merge decision LLM error: ${message}`,
      };
    }

    const mappedPicks = (raw.picks ?? [])
      .map((pick) => {
        const realId = realByShort.get(pick.candidateId);
        if (!realId) {
          this.logger.warn(
            'Scrape merge decision LLM returned unknown candidate short id',
            { shortId: pick.candidateId, ...logContext },
          );
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
        ): pick is { candidateId: string; confidence: number; reason: string } =>
          pick !== undefined,
      );

    if (mappedPicks.length === 0) {
      return {
        kind: 'llm_unresolved',
        confidence: 0,
        reason: 'llm_returned_none',
        selectedCandidates: [],
        evidenceSummary: raw.evidenceSummary,
      };
    }

    // Binary framing — at most one candidate can be the same product as a
    // single scraped listing. Take the highest-confidence pick only, even if
    // the LLM (against instructions) returned more than one.
    const sorted = sortBy(mappedPicks, (pick) => -pick.confidence);
    const best = sorted[0];

    if (best.confidence < acceptThreshold) {
      return {
        kind: 'llm_unresolved',
        confidence: best.confidence,
        reason: 'below_accept_threshold',
        selectedCandidates: [],
        evidenceSummary: raw.evidenceSummary,
      };
    }

    return {
      kind: 'llm_resolved',
      confidence: best.confidence,
      reason: 'llm_resolved',
      selectedCandidates: [best],
      evidenceSummary: raw.evidenceSummary,
    };
  }

  private buildUserMessage(
    context: ResolutionContext,
    candidates: SlimCandidate[],
    shortIdByReal: Map<string, string>,
  ): string {
    const input = context.input;
    const lines: string[] = [];

    lines.push('## Scraped Product');
    lines.push(`Brand: ${input.brand ?? 'unknown'}`);
    lines.push(`Model: ${input.model ?? 'unknown'}`);
    if (input.displayName) lines.push(`Listing title: ${input.displayName}`);
    if (input.specs?.length) {
      lines.push(
        `Specs: ${input.specs.map((spec) => `${spec.name}=${spec.value}`).join(', ')}`,
      );
    }
    lines.push('');

    if (context.scoring) {
      const parts: string[] = [];
      if (context.scoring.normalizedInput) {
        parts.push(`normalized input: "${context.scoring.normalizedInput}"`);
      }
      if (context.scoring.failedGates?.length) {
        parts.push(
          `matcher gates failed: ${context.scoring.failedGates.join(', ')}`,
        );
      }
      if (parts.length > 0) {
        lines.push(
          '## Matcher Diagnostics (soft evidence — the deterministic matcher could not confidently accept or reject)',
        );
        for (const part of parts) lines.push(`- ${part}`);
        lines.push('');
      }
    }

    lines.push('## Candidate Catalog Products');
    lines.push(
      'Each is an existing product already in the catalog. Decide whether the scraped product above is the SAME physical product as ONE of these — not a different but related product (different model line, different generation, incompatible primary specs).',
    );
    lines.push('');
    for (const candidate of candidates) {
      const shortId =
        shortIdByReal.get(candidate.productId) ?? candidate.productId;
      lines.push(`- ${formatCandidate(candidate, shortId)}`);
    }

    return lines.join('\n');
  }
}

function buildSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      picks: {
        type: 'array',
        minItems: 0,
        maxItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            candidateId: { type: 'string' },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
            reason: { type: 'string' },
          },
          required: ['candidateId', 'confidence', 'reason'],
        },
      },
      evidenceSummary: { type: 'string' },
    },
    required: ['picks', 'evidenceSummary'],
  } as const;
}

function buildSystemPrompt(): string {
  return `You are adjudicating a single yes/no product-identity question for a price-comparison catalog. A product listing was just scraped from a webshop; a deterministic matcher already searched the catalog and found candidate(s) that are similar but not confident enough to auto-accept. Your job is to decide whether the scraped listing and ONE specific candidate are the SAME physical product (same model/SKU, allowing only for offer-level differences like size or color that have already been stripped out) — not whether they are merely related or similar.

Return an array \`picks\` with AT MOST ONE entry — this is a binary decision, not a pick-the-best-of-many task. Include an entry only for the candidate you believe is a genuine match.
- candidateId: the candidate's short id (e.g. "c1"). Must appear in the candidate list — never invent one.
- confidence: 0..100 INTEGER. 0 = definitely not the same product, 100 = certain it's the same product.
- reason: 1 sentence citing the specific evidence (matching spec values, matching model designation, etc.) that anchors this decision.

Be conservative — this decision merges the scraped listing's price/offer data onto the candidate's existing catalog entry. A wrong "yes" corrupts an existing product's data; a "no" (or empty picks) is safe by comparison, since the scraper simply creates a new catalog entry instead, and a human can correct a wrong "no" later. Weigh evidence as follows:
- Matching primary/critical specs (e.g. motor, battery capacity, frame material, screen size, resolution) is strong positive evidence. A mismatch in any of these is strong evidence AGAINST a match, even if the model name looks similar — different trims/generations of the same product line often keep a similar name but differ in exactly these specs.
- A near-identical model name/designation (same alphanumeric code, same edition name, differing only in word order, spacing, or punctuation) is strong positive evidence.
- A model name that differs in a way that looks like a genuine variant discriminator (different generation number, different suffix letter that other evidence doesn't explain) is evidence AGAINST a match.
- If the scraped listing's specs are sparse or mostly missing, do not compensate with a high confidence based on name similarity alone — a thin-specs listing is exactly the case where a wrong merge is hardest to catch later, so default toward lower confidence when specs cannot corroborate the name match.
- Only use evidence actually present in the input. Never assume a spec value that isn't given.

Return an empty \`picks\` array when no candidate is confidently the same product as the scraped listing.`;
}

function formatCandidate(candidate: SlimCandidate, shortId: string): string {
  const name =
    candidate.displayName ??
    `${candidate.brand ?? ''} ${candidate.model ?? ''}`.trim();
  const specs = renderSpecs(candidate.specs);
  const parts: string[] = [];
  if (candidate.matchScore != null) {
    const score = candidate.matchScore;
    const label = score < 50 ? 'low' : score < 70 ? 'moderate' : 'high';
    parts.push(`matcher confidence: ${score} (${label})`);
  }
  const matcherNote = parts.length > 0 ? ` | ${parts.join('; ')}` : '';
  return `id=${shortId}: ${name}${specs ? ` | ${specs}` : ''}${matcherNote}`;
}

function renderSpecs(specs: SlimCandidate['specs']): string {
  if (!specs) return '';
  return Object.entries(specs)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    )
    .slice(0, MAX_SPECS_RENDERED)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}
