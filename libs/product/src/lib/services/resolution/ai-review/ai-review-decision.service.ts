import { Injectable } from '@nestjs/common';
import { AiChatService } from '@fittkereso-backend/ai';
import {
  ProductResolutionFlow,
  ResolutionAiConfidence,
  ResolutionAiRecommendedAction,
  ResolutionAiVerdict,
  ResolutionCorrection,
  type ProductResolutionAiReview,
  type SpecMatchDetails,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { isEmpty } from 'lodash';
import type { AiReviewContext, AiReviewCandidate } from './ai-review-context-builder.service';
import type { AiAutomationConfig } from '../resolution-trust-rule';
import { TRIGGER_GUIDANCE } from './ai-review-trigger-guidance';

/** What the model returns, before short ids are mapped back to real ones. */
interface RawAiReview {
  verdict: ResolutionAiVerdict;
  recommendedAction: ResolutionAiRecommendedAction;
  targetCandidateId?: string;
  confidence: ResolutionAiConfidence;
  reasoning: string;
  evidenceCited: string[];
}

export interface AiReviewOutcome {
  review: Omit<ProductResolutionAiReview, 'executed'>;
  confidence: ResolutionAiConfidence;
}

/**
 * One LLM call: does the system's conclusion about this row hold up?
 *
 * The model is asked to judge the *decision*, not to redo the resolution. That
 * framing matters — the matcher has already done the string work far more
 * cheaply and consistently than an LLM would, and the questions left over are
 * exactly the ones it cannot answer: is this alias gap or that spec vocabulary
 * difference the same product under two names, or genuinely two products?
 */
@Injectable()
export class AiReviewDecisionService {
  private readonly logger = new CustomLogger(AiReviewDecisionService.name);

  constructor(private readonly aiChatService: AiChatService) {}

  public async decide(
    context: AiReviewContext,
    config: AiAutomationConfig,
  ): Promise<AiReviewOutcome> {
    const response = await this.aiChatService.createChat({
      costLabel: 'resolution_ai_review',
      model: config.model,
      effort: config.effort,
      schema: REVIEW_SCHEMA,
      schemaName: 'resolution_ai_review',
      strictSchema: true,
      logContext: { resolutionId: context.resolution.id },
      messages: [
        { role: 'system', content: systemPrompt(context) },
        { role: 'user', content: userMessage(context) },
      ],
      // A short id the model invented is a verdict about a product that is not
      // on the table. Rejecting it here rather than at parse time buys a retry,
      // which is the difference between a wasted call and a usable one.
      validateResponse: (parsed) => {
        const raw = parsed as RawAiReview;
        if (
          raw.recommendedAction === ResolutionAiRecommendedAction.merge_into &&
          !context.realIdByShortId.has(raw.targetCandidateId ?? '')
        ) {
          throw new Error(
            `merge_into names an unknown candidate "${raw.targetCandidateId}"`,
          );
        }
      },
    });

    // `parsed` is the schema-validated object the chat service already produced
    // — re-parsing the raw text would skip that validation and could yield a
    // shape the schema had rejected.
    const raw = (response.parsed ??
      JSON.parse(response.content || '{}')) as RawAiReview;

    const targetProductId = raw.targetCandidateId
      ? context.realIdByShortId.get(raw.targetCandidateId)
      : undefined;

    if (raw.targetCandidateId && !targetProductId) {
      this.logger.warn('AI review named an unknown candidate short id', {
        resolutionId: context.resolution.id,
        shortId: raw.targetCandidateId,
      });
    }

    // Abstain is a real outcome, not a failure — but it must never authorise an
    // action, so it collapses to the confidence that keeps the row pending.
    const confidence =
      raw.verdict === ResolutionAiVerdict.abstain
        ? ResolutionAiConfidence.low
        : raw.confidence;

    return {
      confidence,
      review: {
        verdict: raw.verdict,
        recommendedAction: raw.recommendedAction,
        targetProductId,
        reasoning: raw.reasoning,
        evidenceCited: raw.evidenceCited ?? [],
        model: config.model,
        costUsd: response.cost,
      },
    };
  }
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['agree', 'disagree', 'abstain'] },
    recommendedAction: {
      type: 'string',
      enum: ['accept', 'dismiss', 'split', 'merge_into'],
    },
    targetCandidateId: {
      type: 'string',
      description:
        'Required for merge_into: the short id (c1, c2, …) of the product to merge into. Omit otherwise.',
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
    evidenceCited: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'recommendedAction', 'confidence', 'reasoning', 'evidenceCited'],
} as const;

function systemPrompt(context: AiReviewContext): string {
  const isDuplicatePair =
    context.resolution.flow === ProductResolutionFlow.duplicate_detection;

  return `You are auditing one product-identity decision an automated pipeline already made. Your job is to say whether that decision holds up — not to redo it from scratch. The matcher has already done the string comparison; you are here for the judgement it cannot make.

What you are good for, and what the matcher is not:
- Recognising that two differently-spelled names are the same thing ("Bosch Performance Line CX (Smart System)" and "Bosch PERFORMANCE CX Gen.4 SMART SYSTEM" are one motor).
- Recognising that two near-identical names are different things (a model year, a frame size, a trim level that changes the product's identity).
- Reading specs written in different vocabularies by two shops and seeing whether they actually agree.

Each candidate below is listed with its brand, model, aliases and specs, as the catalog holds them. "Key specs" are the ones that decide identity for this category; compare them against the input yourself. A key spec that genuinely contradicts means these are different products, while one differing only in units, spelling or formatting does not.

What you must NOT do:
- Do not re-score names. A low matcher score is evidence, not a verdict; a high one is not proof.
- Do not invent a candidate. Every id you name must appear in the Candidates list below.
- Do not guess when the evidence is genuinely thin. Abstaining is a correct answer and costs nothing; a confident wrong merge deletes a product.

${isDuplicatePair ? DUPLICATE_FRAMING : RESOLUTION_FRAMING}

Return:
- verdict: "agree" if the pipeline's outcome was right, "disagree" if it was wrong, "abstain" if the evidence cannot settle it.
- recommendedAction: what should happen now. It MUST be one of the actions listed as available on this row — anything else will be refused.
  - accept — confirm the outcome. Pair with verdict "agree".
  - dismiss — record that the outcome was wrong without changing the catalog. Use when you disagree but the right fix is not one of the others.
  - split — carve this listing back out onto its own product. Use when a listing was attached to a product it does not belong to.
  - merge_into — fold this product into another. Set targetCandidateId to that candidate's short id. This DELETES a product; use it only when the two are unambiguously the same thing.
- confidence: "high" only when you would stake the catalog on it — high confidence authorises the action to be carried out automatically. "medium" when you believe it but a human should confirm. "low" when you are unsure.
- reasoning: one short paragraph, citing the specific fields that decided it.
- evidenceCited: the field names or values you actually used, e.g. ["live specs: motor", "aliases", "matcher gate: primary_spec_mismatch"]. A verdict that cites nothing is a verdict nobody can check.`;
}

const RESOLUTION_FRAMING = `This row is a **scrape-time resolution**: a listing was scraped, and the pipeline either matched it to an existing product or created a new one for it. That has ALREADY HAPPENED — the row records it, it is not a proposal. Accepting confirms it; disagreeing means the catalog currently holds something wrong and names the fix.`;

const DUPLICATE_FRAMING = `This row is a **duplicate proposal**: the pipeline flagged two existing products as possibly the same and changed NOTHING. Accepting it EXECUTES A MERGE and deletes one of the two products. Dismissing it records that they are different. There is no third state — a merge you are not sure about is a merge that should not happen yet.`;

function userMessage(context: AiReviewContext): string {
  const { resolution, candidates, state, triggers } = context;
  const lines: string[] = [];

  lines.push('## What the pipeline concluded');
  const seed = resolution.decisions?.[0];
  if (seed) {
    lines.push(`Verdict: ${seed.verdict}`);
    lines.push(
      `Action: ${seed.action.kind}${seed.actionPerformed ? ' (already carried out)' : ' (proposed, not carried out)'}`,
    );
  }
  if (resolution.decisionSnapshot) {
    lines.push(
      `Decision path: ${resolution.decisionSnapshot.kind} — ${resolution.decisionSnapshot.reason}`,
    );
    if (resolution.decisionSnapshot.evidenceSummary) {
      lines.push(`Summary: ${resolution.decisionSnapshot.evidenceSummary}`);
    }
  }
  lines.push(`Similarity score: ${resolution.similarityScore}`);
  lines.push(`System confidence: ${resolution.decisionConfidence ?? 'unscored'}`);
  lines.push('');

  // The triggers route the model's attention. This is their second job, after
  // blocking auto-accept — a generic "check this row" prompt gets generic
  // answers, while naming the suspicion gets the specific comparison made.
  if (!isEmpty(triggers)) {
    lines.push('## Why this row was flagged — look at these specifically');
    for (const trigger of triggers) {
      lines.push(`- **${trigger}**: ${TRIGGER_GUIDANCE[trigger] ?? trigger}`);
    }
    lines.push('');
  }

  const snapshot = resolution.inputSnapshot;
  if (snapshot?.kind === 'product_resolution') {
    lines.push('## The scraped listing');
    lines.push(`Brand: ${snapshot.input.brand ?? 'unknown'}`);
    lines.push(`Model: ${snapshot.input.model ?? 'unknown'}`);
    if (snapshot.input.displayName) {
      lines.push(`Listed as: ${snapshot.input.displayName}`);
    }
    if (!isEmpty(snapshot.input.specs)) {
      lines.push(
        `Scraped specs: ${(snapshot.input.specs ?? [])
          .map((spec) => `${spec.name}=${spec.value}`)
          .join(', ')}`,
      );
    }
    // The normalized form the matcher actually compared against. Worth showing
    // beside the raw scrape: a spec that survived normalization differently from
    // how it was published is one of the ways a good match gets scored badly.
    if (!isEmpty(snapshot.effectiveMatchSpecs)) {
      lines.push(`Normalized match specs: ${formatSpecMap(snapshot.effectiveMatchSpecs)}`);
    }
    lines.push('');
  } else if (snapshot?.kind === 'duplicate_detection') {
    lines.push('## The two products being compared');
    lines.push(`A: ${snapshot.query.displayName ?? snapshot.query.model}`);
    if (!isEmpty(snapshot.query.aliases)) {
      lines.push(`A aliases: ${snapshot.query.aliases.join(' | ')}`);
    }
    if (!isEmpty(snapshot.query.specs)) {
      lines.push(`A specs: ${formatSpecMap(snapshot.query.specs)}`);
    }
    lines.push(`B: ${snapshot.candidate.displayName ?? snapshot.candidate.model}`);
    if (!isEmpty(snapshot.candidate.aliases)) {
      lines.push(`B aliases: ${snapshot.candidate.aliases.join(' | ')}`);
    }
    if (!isEmpty(snapshot.candidate.specs)) {
      lines.push(`B specs: ${formatSpecMap(snapshot.candidate.specs)}`);
    }
    lines.push(`Trigram pre-filter score: ${snapshot.trigramScore}`);
    lines.push('');
  }

  lines.push('## Candidates');
  lines.push(
    'Matcher figures are what the pipeline derived at the time. Product details are LIVE — as the catalog holds them right now, which is what any action would act on.',
  );
  lines.push('');
  for (const candidate of candidates) {
    lines.push(formatCandidate(candidate));
  }
  lines.push('');

  lines.push('## Actions available on this row');
  lines.push(
    'These are re-derived from live database state. Recommending anything else will be refused.',
  );
  for (const action of state.availableActions) {
    const label = action.correction
      ? `${action.action} (${action.correction})`
      : action.action;
    lines.push(`- ${label}`);
  }
  if (!isEmpty(state.blockedReasons)) {
    lines.push(`Blocked: ${state.blockedReasons.join(', ')}`);
  }

  return lines.join('\n');
}

function formatCandidate(candidate: AiReviewCandidate): string {
  const lines: string[] = [];
  const live = candidate.live;

  const name = live
    ? (live.displayName ?? `${live.brand ?? ''} ${live.model ?? ''}`.trim())
    : '(product no longer exists)';
  lines.push(`### ${candidate.shortId}: ${name}`);

  if (!live) {
    // Decisive on its own, and it must not read as a candidate still in play.
    lines.push(
      '- This product has been deleted or merged away since the decision was recorded. It cannot be merged into.',
    );
    return lines.join('\n');
  }

  if (candidate.fromCatalogLookup) {
    lines.push(
      '- Found by a catalog lookup, NOT by recall — it was never scored, so it has no matcher figures. Its presence here is the point: recall should probably have found it.',
    );
  }

  if (live.brand) lines.push(`- Brand: ${live.brand}`);
  if (live.model) lines.push(`- Model: ${live.model}`);
  if (live.category) lines.push(`- Category: ${live.category}`);
  if (!isEmpty(live.aliases)) {
    lines.push(`- Known aliases: ${live.aliases.join(' | ')}`);
  }

  // The identity-defining and matcher specs lead, then everything else. Both
  // come from the same live spec map — the split is only about ordering, so the
  // specs a merge turns on are read first rather than hunted for in a list of
  // thirty.
  //
  // A candidate the matcher never scored has no comparison to read those keys
  // off, and splitting on an empty set would file every spec — decisive ones
  // included — under "Other". So the split only happens when it is informed.
  const decisiveKeys = decisiveSpecKeys(candidate.specMatchDetails);
  if (live.specs && !isEmpty(live.specs)) {
    if (isEmpty(decisiveKeys)) {
      lines.push(`- Specs: ${formatSpecMap(live.specs)}`);
    } else {
      const decisive = pickSpecs(live.specs, (key) => decisiveKeys.has(key));
      const rest = pickSpecs(live.specs, (key) => !decisiveKeys.has(key));

      if (!isEmpty(decisive)) {
        lines.push(`- Key specs: ${formatSpecMap(decisive)}`);
      }
      if (!isEmpty(rest)) lines.push(`- Other specs: ${formatSpecMap(rest)}`);
    }
  }
  lines.push(
    `- Catalog presence: ${live.offerCount} offer(s)${live.price ? `, price ${live.price}` : ''}`,
  );

  if (candidate.matchScore !== undefined) {
    lines.push(`- Matcher score: ${candidate.matchScore}`);
  }
  if (candidate.gates && !candidate.gates.passed) {
    lines.push(
      `- Failed gates: ${candidate.gates.failedGates.join(', ') || '(none recorded)'}`,
    );
  }
  if (candidate.filtered) {
    lines.push(
      `- Dropped before scoring — ${candidate.filtered.reason}: ${candidate.filtered.detail}`,
    );
  }
  return lines.join('\n');
}

/**
 * This candidate's identity-defining and matcher specs, as values.
 *
 * Deliberately *not* the matcher's own per-spec verdict. Its `match`/`mismatch`
 * call is a string comparison, and the whole reason to ask a model is that
 * `85Nm` and `85 Nm` are the same torque while the matcher scores them as a
 * contradiction. Handing over its conclusion invites the model to inherit the
 * mistake; handing over the values lets it do the judgement it is better at.
 *
 * The counts stay as a one-line summary — they say how hard the matcher found
 * the comparison, which is context for *why the row was flagged* rather than
 * evidence about the products.
 *
 * Which keys matter comes from the comparison's own `isPrimary`/`isMatcher`
 * flags, so the category's spec configuration is honoured without this needing
 * to read config. Everything else is left out: a bike carries dozens of specs
 * and a full dump buries the handful a merge turns on.
 */
/**
 * The spec keys that decide identity for this category — the primary ones plus
 * the matcher's own weighted set.
 *
 * Read off the stored comparison rather than from category config, so the keys
 * are the ones this row was actually judged on. A row whose comparison never ran
 * (a filtered candidate, or one recall never scored) yields an empty set, and
 * every spec is simply listed together.
 */
function decisiveSpecKeys(specs?: SpecMatchDetails): Set<string> {
  return new Set(
    (specs?.details ?? [])
      .filter((detail) => detail.isPrimary || detail.isMatcher)
      .map((detail) => detail.key),
  );
}

function pickSpecs(
  specs: Record<string, unknown>,
  predicate: (key: string) => boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(specs).filter(([key]) => predicate(key)),
  );
}

/** A `key=value` spec map, skipping keys with nothing in them — an absent spec
 *  says nothing, and a line of `key=` noise costs the model attention. */
function formatSpecMap(specs: Record<string, unknown> | undefined): string {
  return Object.entries(specs ?? {})
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    )
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}


/** The correction a recommendation maps to, or `undefined` when the action is
 *  not a decline. Kept beside the prompt that produces the vocabulary so the two
 *  cannot drift. */
export function correctionFor(
  action: ResolutionAiRecommendedAction,
): ResolutionCorrection | undefined {
  switch (action) {
    case ResolutionAiRecommendedAction.split:
      return ResolutionCorrection.split;
    case ResolutionAiRecommendedAction.merge_into:
      return ResolutionCorrection.merge_into;
    case ResolutionAiRecommendedAction.dismiss:
      return ResolutionCorrection.dismiss;
    case ResolutionAiRecommendedAction.accept:
    default:
      return undefined;
  }
}
