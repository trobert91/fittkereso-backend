import { Injectable } from '@nestjs/common';
import { compact, isEmpty, isNil, orderBy } from 'lodash';
import { AiChatService } from '@fittkereso-backend/ai';
import type {
  ListingMatchLlmRecord,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  LLM_ACCEPT_CONFIDENCE,
  LLM_MODEL,
} from './product-identity.constants';
import type { FailedGate, ProductCandidate } from './types';

/** Specs rendered per product, so a long spec set can't crowd out the prompt. */
const MAX_SPECS_RENDERED = 8;

/** The listing, as the prompt describes it. */
export interface ListingMatchLlmQuery {
  brandName: string;
  model?: string;
  displayName?: string;
  /** The key recall and scoring ran on. */
  nameKey: string;
  specs?: ProductSpecs;
}

interface RawListingMatchResponse {
  picks?: Array<{ candidateId: string; confidence: number; reason: string }>;
  evidenceSummary?: string;
}

/**
 * The near-miss check: is this scraped listing the same physical product as one
 * of these catalog candidates? Asked only when the score couldn't decide on its
 * own (listing-match-decision.ts), and deliberately conservative — a wrong yes
 * attaches offers to the wrong product, while a no just creates a redundant
 * one a person can merge later.
 *
 * Candidates are shown as c1..cN rather than by id: short ids keep the model
 * from echoing a uuid it half-remembers, and anything outside the list is
 * dropped.
 */
@Injectable()
export class ListingMatchLlmService {
  private readonly logger = new CustomLogger(ListingMatchLlmService.name);

  constructor(private readonly aiChatService: AiChatService) {}

  public async pick(
    query: ListingMatchLlmQuery,
    candidates: ProductCandidate[],
    logContext?: Record<string, string>,
  ): Promise<ListingMatchLlmRecord> {
    const productIdByShortId = new Map(
      candidates.map((candidate, index) => [
        `c${index + 1}`,
        candidate.productId,
      ]),
    );

    let raw: RawListingMatchResponse;
    try {
      const response = await this.aiChatService.createChat({
        costLabel: 'listing-match',
        schema: buildSchema(),
        schemaName: 'listing_match_decision',
        model: LLM_MODEL,
        logContext,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserMessage(query, candidates) },
        ],
        temperature: 1,
      });
      raw = JSON.parse(
        response.choices[0].message.content ?? '{}',
      ) as RawListingMatchResponse;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Listing match LLM call failed', {
        error: message,
        ...logContext,
      });
      return { error: message };
    }

    const picks = compact(
      (raw.picks ?? []).map((pick) => {
        const productId = productIdByShortId.get(pick.candidateId);
        if (!productId) {
          this.logger.warn('Listing match LLM returned an unknown candidate', {
            candidateId: pick.candidateId,
            ...logContext,
          });
          return undefined;
        }
        return { productId, confidence: pick.confidence, reason: pick.reason };
      }),
    );
    if (isEmpty(picks)) {
      return { reason: raw.evidenceSummary ?? 'no candidate picked' };
    }

    // A listing is exactly one product, so only the most confident pick counts
    // even when the model returns more than the schema allows.
    const best = orderBy(picks, (pick) => pick.confidence, 'desc')[0];
    if (best.confidence < LLM_ACCEPT_CONFIDENCE) {
      // Declined: the reason is worth keeping, the pick isn't.
      return { confidence: best.confidence, reason: best.reason };
    }

    return best;
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
  return `You are adjudicating a single yes/no product-identity question for a price-comparison catalog. A product listing was just scraped from a webshop; a deterministic matcher already searched the catalog and found candidate(s) that are similar but not similar enough to accept on their own. Your job is to decide whether the scraped listing and ONE specific candidate are the SAME physical product (same model/SKU, allowing only for offer-level differences like size or color that have already been stripped out) — not whether they are merely related or similar.

Return an array \`picks\` with AT MOST ONE entry — this is a binary decision, not a pick-the-best-of-many task. Include an entry only for the candidate you believe is a genuine match.
- candidateId: the candidate's short id (e.g. "c1"). Must appear in the candidate list — never invent one.
- confidence: 0..100 INTEGER. 0 = definitely not the same product, 100 = certain it's the same product.
- reason: 1 sentence citing the specific evidence (matching spec values, matching model designation, etc.) that anchors this decision.

Each candidate carries the matcher's own score (1..100) and the contradictions it found, written as "-30 modelYear: 2024 vs 2023" — the points that check took off, the field, the listing's value and the candidate's value. Treat those contradictions as evidence you must explain away, not as a verdict.

Be conservative — this decision merges the scraped listing's price/offer data onto the candidate's existing catalog entry. A wrong "yes" corrupts an existing product's data; a "no" (or empty picks) is safe by comparison, since the scraper simply creates a new catalog entry instead, and a human can correct a wrong "no" later. Weigh evidence as follows:
- Matching primary/critical specs (e.g. motor, battery capacity, frame material, screen size, resolution) is strong positive evidence. A mismatch in any of these is strong evidence AGAINST a match, even if the model name looks similar — different trims/generations of the same product line often keep a similar name but differ in exactly these specs.
- A near-identical model name/designation (same alphanumeric code, same edition name, differing only in word order, spacing, or punctuation) is strong positive evidence.
- A model name that differs in a way that looks like a genuine variant discriminator (different generation number, different suffix letter that other evidence doesn't explain) is evidence AGAINST a match.
- If the scraped listing's specs are sparse or mostly missing, do not compensate with a high confidence based on name similarity alone — a thin-specs listing is exactly the case where a wrong merge is hardest to catch later, so default toward lower confidence when specs cannot corroborate the name match.
- Only use evidence actually present in the input. Never assume a spec value that isn't given.

Return an empty \`picks\` array when no candidate is confidently the same product as the scraped listing.`;
}

function buildUserMessage(
  query: ListingMatchLlmQuery,
  candidates: ProductCandidate[],
): string {
  const lines = [
    '## Scraped Product',
    `Brand: ${query.brandName}`,
    `Model: ${query.model ?? 'unknown'}`,
  ];
  if (query.displayName) lines.push(`Listing title: ${query.displayName}`);
  lines.push(`Matched on name key: "${query.nameKey}"`);
  const specs = renderSpecs(query.specs);
  if (specs) lines.push(`Specs: ${specs}`);

  lines.push(
    '',
    '## Candidate Catalog Products',
    'Each is an existing product already in the catalog. Decide whether the scraped product above is the SAME physical product as ONE of these — not a different but related product (different model line, different generation, incompatible primary specs).',
    '',
  );
  candidates.forEach((candidate, index) =>
    lines.push(`- ${formatCandidate(candidate, `c${index + 1}`)}`),
  );

  return lines.join('\n');
}

function formatCandidate(
  candidate: ProductCandidate,
  shortId: string,
): string {
  const specs = renderSpecs(candidate.specs);
  const parts = [
    `id=${shortId}: ${candidate.displayName}`,
    ...(specs ? [specs] : []),
    `score ${candidate.score}`,
    renderGates(candidate.failedGates),
  ];
  return parts.join(' | ');
}

function renderGates(failedGates: FailedGate[]): string {
  if (isEmpty(failedGates)) return 'no contradictions found';
  return failedGates
    .map(
      (gate) =>
        `-${gate.severity} ${gate.spec ?? gate.gate}: ${renderValue(gate.queryValue)} vs ${renderValue(gate.candidateValue)}`,
    )
    .join('; ');
}

function renderSpecs(specs: ProductSpecs | undefined): string {
  return Object.entries(specs ?? {})
    .filter(([, value]) => !isNil(value) && value !== '')
    .slice(0, MAX_SPECS_RENDERED)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(', ');
}

function renderValue(value: unknown): string {
  return Array.isArray(value) ? value.join(' ') : String(value);
}
