import {
  Depth,
  ExperienceType,
  Intent,
  Sentiment,
  ValidationCase,
  ValidationCases,
} from "@ebike-backend/database";
import { ThreadCategoryConfig } from "../models/thread-context";

const EXPERIENCE_DOCS: Record<ExperienceType, string> = {
  [ExperienceType.Owner]:
    "bought or otherwise acquired the product, including currently owning, calibrating, or considering a return.",
  [ExperienceType.PriorOwner]:
    "previously owned and has now returned, sold, or upgraded away from the product.",
  [ExperienceType.Tested]:
    "used the product hands-on without owning it (store demo, friend's unit, trial).",
  [ExperienceType.ProspectiveBuyer]:
    "researching the product with no hands-on contact yet.",
  [ExperienceType.Reference]:
    "relaying external information with no personal stake (citing reviews, benchmarks, hearsay).",
};

const DEPTH_DOCS: Record<Depth, string> = {
  [Depth.Comprehensive]: "3+ distinct aspects discussed with specifics.",
  [Depth.Detailed]:
    "at least one specific observation with reasoning or context.",
  [Depth.Mentioned]:
    "names a feature, OR an owner gives a verdict without a named attribute.",
  [Depth.Superficial]: "no evaluative content survived the quote gate.",
};

const INTENT_DOCS: Record<Intent, string> = {
  [Intent.Recommendation]: "tells others to buy / try / avoid the product.",
  [Intent.IssueReport]: "reports a defect, problem, or rejection.",
  [Intent.Comparison]:
    "compares the product against another, including baselines.",
  [Intent.ExperienceReport]:
    "shares first-hand usage without explicitly recommending.",
  [Intent.Warning]:
    "warns others away from the product or a specific scenario.",
  [Intent.SeekingAdvice]: "asks the community for input on this product.",
  [Intent.Question]: "asks a factual question about the product.",
  [Intent.ReputationReport]:
    "relays general reputation or community opinion (not first-hand).",
};

const SENTIMENT_DOCS: Record<Sentiment, string> = {
  [Sentiment.StrongPositive]:
    "strong-language praise or regret-of-not-buying-sooner.",
  [Sentiment.Positive]:
    "measured praise; defensive rebuttals and weak preferences land here, not strongPositive.",
  [Sentiment.Neutral]: "describes the product without valence.",
  [Sentiment.Negative]: "measured criticism without strong-language severity.",
  [Sentiment.StrongNegative]:
    'strong-language complaint or an act of rejection ("returned it", "sent it back" — the act alone is enough).',
  [Sentiment.Mixed]:
    "one clause expresses both sides and cannot cleanly split.",
};

function renderEnumBlock<T extends string>(
  title: string,
  docs: Record<T, string>,
): string {
  const lines = (Object.entries(docs) as [T, string][])
    .map(([value, doc]) => `  - ${value}: ${doc}`)
    .join("\n");
  return `${title}\n${lines}`;
}

// ─── Worked-case resolution ──────────────────────────────────────────────────

/**
 * Neutral fallback worked-case catalogue. Used when no active category provides
 * `validationCases`. Intentionally minimal — teaches the SHAPE of a case and
 * exercises each emittable issue type at least once with neutral "Product A" /
 * "Product B" placeholders. Category owners are expected to populate
 * `validationCases` in their config.json so threads see relevant examples.
 */
const FALLBACK_CASES: ValidationCases = [
  {
    note: "Whole comment is praise but sentiment is set to negative — single-type wrong_sentiment.",
    input:
      '[VALIDATE] @user1: "Just got Product A and it\'s amazing — colors pop, build feels solid, would buy again."\n  Ref A (Product A): experience: owner, sentiment: negative',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "wrong_sentiment",
              suggestedSentiment: "positive",
              reasoning:
                "Every quote is praise — sentiment is positive, not negative.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "Past-tense rejection misclassified as owner.",
    input:
      '[VALIDATE] @user2: "I had Product A for a year before returning it — the build started failing after month 6."\n  Ref A (Product A): experience: owner',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "wrong_experience",
              suggestedExperience: "prior_owner",
              reasoning:
                "Speaker explicitly says they returned the product — that is prior_owner, not owner.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "Multi-aspect comprehensive comment misclassified as mentioned.",
    input:
      '[VALIDATE] @user3: "Product A\'s build quality is solid, the controls are intuitive, and the value is hard to beat at this price."\n  Ref A (Product A): depth: mentioned',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "wrong_depth",
              suggestedDepth: "comprehensive",
              reasoning:
                "3 named aspects (build, controls, value) with specifics — that is comprehensive, not mentioned.",
            },
          ],
        },
      ],
    },
  },
  {
    note: 'Implicit prescriptive recommendation. Imperative "just get X" without `recommendation` in the intent set.',
    input:
      '[VALIDATE] @user4: "Honestly, just get Product A. You won\'t regret it."\n  Ref A (Product A): intents: [experience_report]',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "wrong_intent",
              suggestedIntents: ["recommendation"],
              reasoning:
                "'Just get Product A' is a prescriptive imperative — recommendation is the correct intent.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "Wrong product resolution — comment is plainly about Product A, ref resolves to Product B.",
    input:
      '[VALIDATE] @user5: "I love Product A — colors are great, build is solid."\n  Ref A (Product B): experience: owner',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "wrong_product",
              reasoning:
                "Comment is plainly about Product A. Resolved product is Product B — different product entirely.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "Quote names a different product than the ref. Belongs on the other ref.",
    input:
      '[VALIDATE] @user6: "I\'m comparing Product A and Product B. Product B\'s controls feel cheap."\n  Ref A (Product A): quotes: [q0] "Product B\'s controls feel cheap"\n  Ref B (Product B): (no quotes)',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "wrong_quote_attribution",
              quoteId: "q0",
              reasoning:
                "Quote names Product B as the subject — it belongs on the Product B ref, not Ref A.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "Single ref carries quotes about TWO products — split needed (boundary_violation).",
    input:
      '[VALIDATE] @user7: "Leaning Product A, but Product B is better-built."\n  Ref A (Product A): quotes: [q0] "leaning toward Product A", [q1] "Product B is better-built"',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "boundary_violation",
              reasoning:
                "Ref A mixes evidence about Product A and Product B — should be split into two refs.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "Bare-acquisition quote labeled medium — should be downgraded to low.",
    input:
      '[VALIDATE] @user8: "Just bought Product A on sale for $300. Should arrive Friday."\n  Ref A (Product A): quotes: [q0] "Just bought Product A on sale for $300" quality: medium',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "wrong_quote_quality",
              quoteId: "q0",
              suggestedQuality: "low",
              reasoning:
                "'Just bought Product A on sale for $300' is bare acquisition — no verdict, no named aspect, no first-hand observation. Quality should be low.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "Substantive first-hand observation labeled low — should be upgraded to high.",
    input:
      '[VALIDATE] @user8b: "After 4 months of daily use, the colors still pop and the response time feels instant in my Forza sessions."\n  Ref A (Product A): experience: owner, quotes: [q0] "After 4 months of daily use, the colors still pop and the response time feels instant in my Forza sessions" quality: low',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "wrong_quote_quality",
              quoteId: "q0",
              suggestedQuality: "high",
              reasoning:
                "First-hand observation from an owner naming two aspects (colors, response time) with grounded evaluation. Quality should be high, not low.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "Hedged future-concern wording — speculative should be true even though the speaker is an owner. Trigger is the language, not the tier.",
    input:
      '[VALIDATE] @user9: "I\'m worried about long-term durability on my Product A."\n  Ref A (Product A): experience: owner\n    quotes: [q0] "worried about long-term durability" speculative=false features: [0] durability/con',
    expected: {
      refs: [
        {
          refLabel: "A",
          issues: [
            {
              type: "speculative_flag_mismatch",
              quoteId: "q0",
              suggestedSpeculative: true,
              reasoning:
                "Quote is hedged about a future concern ('worried about long-term durability') — wording is speculative even though the speaker owns the unit.",
            },
          ],
        },
      ],
    },
  },
  {
    note: "SILENT APPROVAL TEACHER. Plausible extraction; stay silent.",
    input:
      '[VALIDATE] @user10: "Bought Product A. Colors are great, build feels solid, would recommend."\n  Ref A (Product A): experience: owner, depth: detailed, sentiment: positive, intents: [experience_report, recommendation]',
    expected: { refs: [] },
  },
];

/**
 * Walk the active categories in priority order and return the first non-empty
 * `validationCases` block we find. Falls back to FALLBACK_CASES when no
 * category provides them. Mirrors how `buildLabelingSystemPrompt` resolves
 * multi-category prompt config.
 */
function pickWorkedCases(
  categoryConfigs: ThreadCategoryConfig[],
): ValidationCases {
  for (const category of categoryConfigs) {
    const cases = category.promptConfig?.validationCases;
    if (cases && cases.length > 0) return cases;
  }
  return FALLBACK_CASES;
}

function renderCasesBlock(cases: ValidationCases): string {
  const wrapped = {
    cases: cases.map((c: ValidationCase) => ({
      note: c.note,
      input: c.input,
      expected: c.expected,
    })),
  };
  return "```json\n" + JSON.stringify(wrapped, null, 2) + "\n```";
}

// ─── Static section text ─────────────────────────────────────────────────────

const SECTION_RULE = "─".repeat(77);

const HEADER = `You are a validation reviewer for product extractions made from comments.

You audit each extracted product reference (a "ref") against the comment text and quote-level evidence. You emit a structured list of issues per ref. Silence is approval — emit ONLY when you have clear evidence the extraction is wrong.

── INPUT ─────────────────────────────────────────────────────────────────────

A DFS-ordered comment tree. Each comment is marked [VALIDATE] (a comment whose extracted refs you must validate) or [CONTEXT] (background context — read it to understand the conversation, but do not produce issues against [CONTEXT] refs). Indentation = depth in the reply tree.

Each [VALIDATE] comment carries one or more refs labeled \`Ref A\`, \`Ref B\`, \`Ref C\`, ... in DFS order across the whole subtree (labels do not reset per comment). Use the surrounding [CONTEXT] chain — parent comments, OP, sibling replies — to disambiguate ambiguous quotes.

Each ref carries:
  - resolved product display name (in parentheses after \`Ref X\`)
  - experience tier:  owner | prior_owner | tested | prospective_buyer | reference
  - depth tier:       comprehensive | detailed | mentioned | superficial
  - sentiment:        strongPositive | positive | neutral | negative | strongNegative | mixed
  - intents:          a set of 0–2 intents (see vocabulary below)
  - quotes:           a numbered list \`[q0] "text" sentiment=value speculative=true|false\` — the \`speculative\` flag is per-quote (whole-quote stance, not per-evidence).
  - per-quote feature/useCase evidence rendered as \`label/sentiment\` where sentiment is one of the 6 values above OR the literal string \`inherit\` (label inherits the quote's sentiment).

── OUTPUT SHAPE ──────────────────────────────────────────────────────────────

Return JSON \`{ "refs": [{ "refLabel": "A", "issues": [...] }, ...], "commentReviews": [...] }\`. Refs with zero issues may be omitted; an empty \`refs: []\` is a valid silent-approval response. \`commentReviews\` is OPTIONAL — emit only when a [VALIDATE] comment as a whole warrants moderation (see COMMENT-LEVEL REVIEWS).

Each issue carries:
  - type:       one of the 9 emittable types listed below
  - reasoning:  one short sentence quoting or paraphrasing the comment evidence
  - extra fields per type — see DECISION TABLE below`;

const INVARIANTS = `${SECTION_RULE}
INVARIANTS
${SECTION_RULE}

1. Silence is approval. If the extraction is plausible, emit nothing for that ref.
2. Use refLabel exactly as printed (A, B, C, ...). Never invent labels.
3. Quote a span from the comment in your \`reasoning\`. No reasoning that cites text you cannot find in the rendered subtree.
4. Emit at most one issue PER (refLabel × type) — except \`wrong_quote_quality\` and \`speculative_flag_mismatch\` which are per-quote and MAY repeat for different quoteIds on the same ref.
5. When in doubt between "extraction is wrong" and "extraction is borderline", stay silent. Validation overflagging is worse than misses — it creates review-queue noise.`;

const DECISION_TABLE = `${SECTION_RULE}
DECISION TABLE — the 9 emittable issue types
${SECTION_RULE}

Walk this table top-to-bottom for every ref. A single ref may produce multiple issues across types (e.g. \`wrong_experience\` + \`wrong_intent\` + \`wrong_quote_quality\` together on a misclassified bare-acquisition ref). They are independent.

| # | type | Fire when | Stay silent when | Required extra fields |
|---|------|-----------|------------------|------------------------|
| 1 | wrong_sentiment | All quotes are clearly one valence but \`sentiment\` is the opposite. OR comment carries praise+defect on different clauses but \`sentiment\` is single-valence (not \`mixed\`). | Adjacent values (positive vs mixed) without obvious cross-valence content. | \`suggestedSentiment\` |
| 2 | wrong_experience | Comment shows hands-on contact ("Just got my X", "the unit I tested") but tier is \`prospective_buyer\` / \`reference\`. OR hearsay/research ("I heard...", "I'm thinking about") but tier is \`owner\` / \`tested\`. OR detailed first-hand troubleshooting ("I tried 3 cables, swapped Hz") but tier is \`reference\`. OR past-tense rejection ("I returned the X after a week") but tier is \`owner\`. OR pending order ("I ordered, will arrive Wednesday") but tier is \`owner\`. | Adjacent tiers without explicit signal (e.g. \`owner\` → \`prior_owner\` unless the comment says "I sold it" / "I returned it"). | \`suggestedExperience\` |
| 3 | wrong_depth | 3+ named aspects with specifics or reasoning but tier is \`mentioned\` or \`detailed\`. OR no aspect named at all (just "great monitor") but tier is \`comprehensive\` or \`detailed\`. OR one aspect with no reasoning but tier is \`comprehensive\`. | Adjacent tiers (detailed vs mentioned) without unambiguous evidence. | \`suggestedDepth\` |
| 4 | wrong_intent | The intents set MISSES a clearly-present intent ("Don't get LG" without \`recommendation\` is wrong). OR contains an unsupported intent (\`experience_report\` on a future-tense pending order). Detect implicit recommendations: prescriptive language like "Don't get X", "go with Y", "you should pick Z", "avoid the W", "X is the way" all count as \`recommendation\` even without the literal word. | An OPTIONAL second intent is missing while the first is correct (don't penalize sensible 1-intent sets). | \`suggestedIntents\` |
| 5 | wrong_product | The brand or model name in the parenthetical does NOT match what the comment says. OR comment names product P but ref resolves to a totally different P' (different brand, or same brand but a SKU mismatch large enough to be a different product line). | Slight SKU normalization variant of the same model ("MSI MPG 341CQPX" vs "MSI MPG341CQPX"). OR genuinely ambiguous comment where the resolved product is a plausible reading. | (none) |
| 6 | wrong_quote_attribution | A quote on Ref X explicitly names a different product Y mentioned in the same comment, AND another ref exists for Y. Test: read the quote in isolation. Whose product is it about? If the answer isn't the parenthetical of the ref it sits under, flag it. | General statements ("OLEDs are great") that don't name a specific product. OR comparative quotes where the comparison itself is the point. | \`quoteId\` |
| 7 | boundary_violation | The ref's quote list reads as evidence about TWO distinct products and the cleaner fix is to split the ref. Reasoning must name BOTH products. | Only ONE quote is misattributed and the rest belong to the ref → use \`wrong_quote_attribution\` instead. | (none) |
| 8 | wrong_quote_quality | The labeled \`quality\` on a quote disagrees with the rubric. Compare the labeled value against the rubric in EITHER direction: a quote labeled \`high\` or \`medium\` that carries no buyer-useful evaluation should be \`low\` (bare acquisition, settings dump, neutral logistics, troubleshooting fragment, pure brand trust); a quote labeled \`low\` that names a feature/aspect/spec with a clear verdict or concrete observation should be \`medium\` or \`high\`; a quote labeled \`medium\` whose evaluation is grounded with first-hand specifics should be \`high\`; a quote labeled \`high\` whose verdict is bare or whose framing is third-hand should be \`medium\`. Walk EACH quote independently; one ref may emit multiple \`wrong_quote_quality\` issues. | The labeled quality matches the rubric. | \`quoteId\`, \`suggestedQuality\` |
| 9 | speculative_flag_mismatch | The flag should match the WORDING of the whole quote, not the ref's experience tier. Suggest \`speculative=true\` when the quote is hedged, future-tense, hearsay, or hypothetical — "worried about long-term burn-in", "I heard…", "people say", "should be great", "would probably", "might". Suggest \`speculative=false\` when the quote is a concrete first-hand observation — "colors pop on mine", "text is razor sharp", "I tried 3 cables". An owner stating a concrete observation stays \`false\`; a prospective buyer making a concrete observation about a unit they actually saw also stays \`false\`. A reference-tier speaker reporting a concrete first-hand observation (rare but possible: "I tested one in a Best Buy display") stays \`false\`. One issue per offending quote. | The flag matches the wording of the quote. OR the language is mildly tentative but ambiguous ("I think the colors are good"). When you cannot point to specific hedging or first-hand language in the quote, stay silent. | \`quoteId\`, \`suggestedSpeculative\` (true | false) |`;

const COMMENT_LEVEL_REVIEWS = `${SECTION_RULE}
COMMENT-LEVEL REVIEWS (optional)
${SECTION_RULE}

In addition to per-ref issues, you MAY emit one entry per [VALIDATE] comment in \`commentReviews[]\` when the comment as a whole warrants moderation beyond what individual issues capture. Use sparingly — silence is approval at the comment level too.

Each entry carries:
  - \`commentLabel\`: the @username token printed in the rendered subtree (e.g. \`@user1\`).
  - \`reviewComment\`: a one-sentence justification quoting or paraphrasing the comment evidence.
  - \`suggestedStatus\` (optional): one of \`in_review\` or \`deleted\`.

Emit \`suggestedStatus: "deleted"\` when:
  - The comment is plainly off-topic, spam, advertisement, or harmful.
  - The comment is not in any sense a review of, opinion on, or question about a product.

Emit \`suggestedStatus: "in_review"\` when:
  - The comment carries pervasive issues across multiple refs that human moderators should review.
  - The comment's evidence is so contradictory, hedged, or noisy that you cannot validate the extracted refs reliably.

Stay silent when:
  - The comment is plausibly a normal product discussion, even if some individual refs drew issues.
  - You can express the concern through a per-ref issue type instead.

\`commentReviews\` is independent of per-ref issues — a comment may have both, just one, or neither.`;

const WORKED_CASES_HEADER = `${SECTION_RULE}
WORKED CASES (catalogue)
${SECTION_RULE}

The cases below show representative \`[VALIDATE]\` comments with their extracted refs and the expected validation output. Each case is annotated with what's interesting about it — the cases are not segmented by issue type. Many cases exercise multiple types simultaneously, mirroring how real subtrees look.

Cases with \`expected: { refs: [] }\` are silent-approval teachers: refs that look like they could plausibly draw a flag but the correct answer is to stay silent. Use them as your guide for restraint.`;

const FOOTER = `${SECTION_RULE}
WHEN TO STAY SILENT (decision summary)
${SECTION_RULE}

Stay silent when:
  - The extraction is plausible — even if not the choice you would have made.
  - You cannot decide between two adjacent values (e.g. detailed vs. mentioned, positive vs. mixed).
  - The mismatch you detect is ambiguous in the comment text.
  - The quote names a different product but the speaker is making a comparative statement (not misattribution).
  - The intent set has 1 supported intent and you would add a 2nd; only flag when the EXISTING intent is wrong, not when an OPTIONAL second intent is missing (unless that intent is unambiguous, like "Don't get X" requiring \`recommendation\`).

Emit when:
  - You can quote text from the comment that directly contradicts the extracted attribute.
  - The mismatch is at least ONE step on the ladder (e.g. owner → prospective_buyer is a clear miss; owner → prior_owner is borderline unless the comment explicitly says "I sold it").
  - The evidence entry's speculative flag disagrees with the wording of the clause it summarizes — hedged/future-tense/hearsay clauses must be \`speculative=true\`; concrete first-hand observations must be \`speculative=false\` (regardless of the ref's experience tier).

When uncertain, prefer silence. Validation overflagging creates review-queue noise.`;

// ─── Public builder ──────────────────────────────────────────────────────────

export interface ValidationPromptOptions {
  /** Active focus categories for the thread, in priority order. The first
   *  entry whose `promptConfig.validationCases` is populated wins. Empty array
   *  → neutral fallback catalogue. */
  categoryConfigs: ThreadCategoryConfig[];
}

/**
 * Build the validation system prompt. Static prose comes from compile-time
 * constants; the WORKED CASES catalogue is pulled from the active categories'
 * `promptConfig.validationCases` (highest-priority category wins). Falls
 * back to a neutral generic catalogue when no category provides one.
 *
 * Mirrors `buildLabelingSystemPrompt({ categoryConfigs })` for consistency.
 */
export function buildValidationSystemPrompt(
  options: ValidationPromptOptions,
): string {
  const { categoryConfigs } = options;
  const cases = pickWorkedCases(categoryConfigs);

  return [
    HEADER,
    "",
    INVARIANTS,
    "",
    DECISION_TABLE,
    "",
    COMMENT_LEVEL_REVIEWS,
    "",
    SECTION_RULE,
    "ENUM VOCABULARIES (use these exact strings in `suggested*` fields)",
    SECTION_RULE,
    "",
    renderEnumBlock("experience:", EXPERIENCE_DOCS),
    "",
    renderEnumBlock("depth:", DEPTH_DOCS),
    "",
    renderEnumBlock("intents (set, max 2):", INTENT_DOCS),
    "",
    renderEnumBlock("sentiment:", SENTIMENT_DOCS),
    "",
    WORKED_CASES_HEADER,
    "",
    renderCasesBlock(cases),
    "",
    FOOTER,
  ].join("\n");
}

export function buildValidationUserPrompt(rendered: string): string {
  return `Subtree:\n\n${rendered}\n\nReturn JSON per the schema. Empty refs array means no issues.`;
}
