import {
  FeatureLabelConfig,
  IssueLabelConfig,
  UseCaseConfig,
  flattenUseCaseImplications,
} from "@ebike-backend/database";
import { ThreadCategoryConfig } from "../models/thread-context";
import { SENTIMENT_TIERS_RUBRIC } from "./sentiment-tiers.prompt";

const SECTION_RULE = "─".repeat(78);

// ─── Vocabulary helpers ──────────────────────────────────────────────────────

function buildFeatureLabelsSection(
  features: FeatureLabelConfig[] | undefined,
): string {
  if (!features?.length) return "";

  const lines = features.map((config) => {
    const text = config.shortDescription ?? config.description ?? "";
    return text ? `  - ${config.label} — ${text}` : `  - ${config.label}`;
  });
  return `── FEATURES ──────────────────────────────────────────────────────────────────\n\n${lines.join("\n")}`;
}

function buildUseCaseLabelsSection(
  useCases: UseCaseConfig[] | undefined,
): string {
  if (!useCases?.length) return "";

  const lines = useCases.map(
    (config) =>
      `  - ${config.label}${config.description ? ` — ${config.description}` : ""}`,
  );
  return `── USE CASES ─────────────────────────────────────────────────────────────────\n\n${lines.join("\n")}`;
}

function buildUseCaseImplicationsSection(
  implications: Record<string, string[]>,
): string {
  const entries = Object.entries(implications);
  if (entries.length === 0) return "";

  const longestLabel = Math.max(...entries.map(([useCase]) => useCase.length));
  const lines = entries.map(
    ([useCase, signals]) =>
      `  ${useCase.padEnd(longestLabel)} — ${signals.join(", ")}`,
  );

  return [
    "── USE-CASE SIGNALS (illustrative, not exhaustive) ───────────────────────────",
    "",
    lines.join("\n"),
    "",
    "These are EXAMPLES of phrases that typically point at each use case — not a",
    "closed list. The use case applies whenever the quote evaluates the product",
    "through that lens, whether or not any listed phrase appears verbatim (see",
    "STEP 2).",
  ].join("\n");
}

function buildIssueLabelsSection(
  issueLabels: IssueLabelConfig[] | undefined,
): string {
  if (!issueLabels?.length) return "";

  // Group by parent feature, preserving the order in which each feature first appears.
  const byFeature = new Map<string, IssueLabelConfig[]>();
  for (const issue of issueLabels) {
    const bucket = byFeature.get(issue.feature) ?? [];
    bucket.push(issue);
    byFeature.set(issue.feature, bucket);
  }

  const groups: string[] = [];
  for (const [feature, items] of byFeature) {
    const itemLines = items.map(
      (item) => `  - ${item.label} — ${item.description}`,
    );
    groups.push(`${feature} feature:\n${itemLines.join("\n")}`);
  }

  return [
    "── ISSUE LABELS (closed list — pick by symptom; parent feature shown for context) ──",
    "",
    groups.join("\n\n"),
  ].join("\n");
}

function buildLabelingDiscriminatorsSection(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  const paragraphs: string[] = [];
  for (const config of categoryConfigs) {
    const discriminators = config.promptConfig?.labelingDiscriminators ?? [];
    for (const paragraph of discriminators) {
      paragraphs.push(paragraph);
    }
  }
  return paragraphs.join("\n\n");
}

function buildVocabularySection(config: ThreadCategoryConfig): string {
  const featureSection = buildFeatureLabelsSection(config.features);
  const useCaseSection = buildUseCaseLabelsSection(config.useCases);
  const signalsSection = buildUseCaseImplicationsSection(
    flattenUseCaseImplications(config.useCases),
  );
  const issueSection = buildIssueLabelsSection(config.issues);

  const parts = [
    `── VOCABULARY — ${config.categoryName} ──`,
    featureSection,
    useCaseSection,
    signalsSection,
    issueSection,
  ].filter(Boolean);

  return parts.join("\n\n");
}

function resolveExamples(
  categoryConfigs: ThreadCategoryConfig[],
): string | null {
  for (const config of categoryConfigs) {
    if (config.promptConfig?.labelingExamples) {
      return JSON.stringify(config.promptConfig.labelingExamples, null, 2);
    }
  }
  return null;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface LabelingPromptOptions {
  categoryConfigs: ThreadCategoryConfig[];
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

export function buildLabelingSystemPrompt(
  options: LabelingPromptOptions,
): string {
  const { categoryConfigs } = options;

  const vocabularySections = categoryConfigs.map(buildVocabularySection);
  const examplesJson = resolveExamples(categoryConfigs);
  const discriminators = buildLabelingDiscriminatorsSection(categoryConfigs);
  const discriminatorBlock = discriminators ? `\n\n${discriminators}` : "";

  const examplesBlock = examplesJson
    ? `\n\n${SECTION_RULE}\nEXAMPLES\n${SECTION_RULE}\n\n\`\`\`json\n${examplesJson}\n\`\`\``
    : "";

  return `You label extracted quotes with structured feature, use-case, issue evidence, and an overall quality tier.

── INPUT ─────────────────────────────────────────────────────────────────────

A DFS-ordered comment tree showing the discussion thread. Each comment is
marked [PLAN] (a comment we extracted product references from) or
[CONTEXT] (background context the labeling LLM should read but not label).
Indentation = depth.

PLAN comments with extracted refs include a \`refs:\` block. Each ref is
identified by a productId like "Aa", "Ba", "Bb" (comment letter + product
letter). Each ref carries an experience tier (owner | prior_owner | tested
| prospective_buyer | reference), a depth tier, an overall sentiment, and
a numbered list of quotes (q0, q1, …) with per-quote sentiment.

Use the surrounding comment tree to disambiguate quotes. The reply chain,
parent comments, and OP often reveal whether a "black screen" is about
VRR or about cabling, whether a "great" verdict is about gaming or media,
etc.

Emit one entry per input productId. EVERY quote on every product must
appear in \`quotes[]\` with its \`quality\` tier filled in, even when the
quote earns no feature/useCase/issue evidence.

${SECTION_RULE}
EVIDENCE SHAPE
${SECTION_RULE}

You produce three peer evidence streams plus a quality scalar per quote:

  - features[] — one entry per named aspect of the product the quote
    evaluates (STEP 1).
  - useCases[] — one entry per use case the quote evaluates (STEP 2).
  - issues[]   — one entry per closed-list issue label whose symptom the
    quote describes, with a severity sentiment (STEP 3).
  - quality    — overall buyer-utility tier for this quote (STEP 4).

A separate, per-REFERENCE block (\`referenceLabels\`, STEP 6) captures
cross-quote evidence that no single quote alone can support. Use it
sparingly; quote-level evidence is the default.

Feature and use-case evidence share the same shape:
  - label: an exact label from the relevant vocabulary below.
  - sentiment (OPTIONAL): see "Sentiment semantics" below — omit by
    default, set only when this label diverges from the quote.

Issue evidence has its own shape:
  - label: an exact label from the ISSUE LABELS vocabulary.
  - sentiment (REQUIRED): "negative" for a notable but minor/intermittent
    problem; "strongNegative" for a severe issue — defective unit,
    dealbreaker, return-worthy.

Issue evidence does NOT carry a feature label — the parent feature is
mapped programmatically from the ISSUE LABELS vocabulary. You only pick
the issue label and its severity.

Stance (first-hand vs. hedged/hearsay/future-tense) is captured by a
single \`speculative\` flag on the QUOTE, not per evidence entry — see
SPECULATIVE.

Sentiment semantics for features and useCases:

The \`sentiment\` field is OPTIONAL. OMIT IT BY DEFAULT — each evidence
entry inherits the quote's overall sentiment (printed in brackets after
the quote text, e.g. \`q0: "..." [positive]\`). Only set \`sentiment\` when
this label's sentiment DIVERGES from that bracketed value.

Diverging cases (emit \`sentiment\`):
- Multi-aspect quote with OPPOSITE valences — "love this monitor but
  the stand is terrible" → quote [mixed]; features:
  [{label: "screen", sentiment: strongPositive},
   {label: "stand", sentiment: strongNegative}].
- Label diverges in INTENSITY — "Best monitor I've ever owned, though
  the stand is fine" → quote [strongPositive]; features:
  [{label: "stand", sentiment: neutral}].
- Informational aspect inside a directional quote — "Great monitor and
  it's HDR400 certified" → quote [positive]; features:
  [{label: "HDR support", sentiment: neutral}].

When you do emit \`sentiment\`, use this rubric (same as quote-level):

${SENTIMENT_TIERS_RUBRIC}

Closed-list issues (issues[]) are always negative — sentiment is required
on each entry and is one of "negative" (minor) or "strongNegative" (severe).
The parent feature is mapped programmatically at scoring time. Concrete
defects go to issues[] in STEP 3, not features[] with a negative sentiment.

${SECTION_RULE}
STEP 1 — FEATURE EVIDENCE
${SECTION_RULE}

For each quote, produce zero or more feature evidence entries; never
repeat the same label on the same quote. A single quote can produce
multiple entries when it evaluates several distinct aspects ("colors are
amazing and text is sharp" → colors + text clarity), and can also
produce use-case evidence in STEP 2 and issue evidence in STEP 3.

Assign a feature ONLY when the quote names or clearly describes a label
in the FEATURES vocabulary.

Skip the quote when it does not evaluate a named aspect of the product
— bare verdicts ("huge upgrade", "this monitor is insane"), descriptions
of what the speaker did or tried ("I tried 3 DP cables"), and
statements with no product attribute attached ("I trust LG").

${SECTION_RULE}
STEP 2 — USE-CASE EVIDENCE
${SECTION_RULE}

For each quote, produce zero or more use-case evidence entries; never
repeat the same label on the same quote. Be GENEROUS here — when the
quote evaluates the product while pointing at an activity, content
type, application, or workflow that a listed use case covers, emit the
use case. Implicit framing is enough; the quote does not need to name
the use case verbatim or use any phrase from the USE-CASE SIGNALS list.

Assign a use case when the quote signals a use-case lens AND evaluates
the product through it. The signal can be:

  (i)   An activity, content type, application, or workflow tied to a
        listed use case — even when no phrase from USE-CASE SIGNALS
        appears and the use case is not named:
          "watching movies on it is gorgeous" → movies.
          "reading code is much easier now" → programming.
          "got lost in Skyrim for hours" → immersive gaming.
          "switched to it for daily Excel work and the icons are crisp"
            → office.
          "binged the new season on it" → media consumption.
  (ii)  An explicit name: "great for gaming" → pc gaming.
        "mediocre for productivity" → office.
  (iii) A phrase from USE-CASE SIGNALS used as a lens on the product
        ("G-Sync just works for gaming" → pc gaming).

The USE-CASE SIGNALS list is illustrative, not closed — treat unlisted
phrases the same way when they clearly evaluate the product through a
listed lens. Conversely, a listed phrase used incidentally — without
the product being evaluated through that lens — does NOT earn the use
case.

Do NOT assign a use case when the quote is a bare verdict ("amazing",
"love it"), a feature-only evaluation with no activity context ("colors
pop"), or an activity mention with no evaluation ("tried 4K Blu-ray",
"I tried 60/120Hz").${discriminatorBlock}

${SECTION_RULE}
STEP 3 — ISSUE EVIDENCE
${SECTION_RULE}

For each quote that describes a defect, malfunction, or concrete
negative symptom, scan the ISSUE LABELS vocabulary and emit one issues[]
entry per matching closed-list label, in the shape
\`{label, sentiment}\`.

Match by symptom — what the quote literally describes — not by which
feature you'd attach it to. The parent feature is filled in for you from
the vocabulary at scoring time; you only pick the label and severity.

\`sentiment\` is REQUIRED on every issues[] entry:
  - "negative" — notable problem, intermittent, mildly annoying, minor
    cosmetic defect, occasional bug. The buyer probably keeps the unit.
  - "strongNegative" — severe: DOA, replaced, returned, dealbreaker,
    safety concern, failed RMA, persistent defect that ruins the
    product. The buyer would not recommend keeping it.

When multiple labels plausibly fit the same symptom, pick the closest
description. Use the surrounding comment tree as a tiebreaker — when
the parent comment framed the discussion in one direction, lean that
way.

When a closed-list label genuinely doesn't fit, OMIT issues[] for that
quote. Never coin a label. The quote can still carry a generic features[]
entry with a negative sentiment in STEP 1 if the defect is real but
uncatalogued.

A single quote can produce multiple issues[] entries when it describes
multiple distinct symptoms; each carries its own severity.

A speculative or hearsay symptom still goes to issues[] — stance is
marked by setting \`speculative: true\` on the parent quote.

${SECTION_RULE}
STEP 4 — QUOTE QUALITY
${SECTION_RULE}

For EVERY quote, assign a \`quality\` tier answering this question:
how useful is this quote to someone considering buying the product?

The core test: does the quote COMMIT to something the buyer can
act on? A commitment is one of:
  (a) a first-hand observation about the product,
  (b) a specific condition that grounds a concern or claim,
  (c) a purchase outcome (returned, kept, replaced, recommend),
  (d) a direct evaluation of the product (positive or negative).

Hedges like "might…", "is said to…", "could be…", "I'd expect…",
"supposedly…" undo commitment. A quote that names features but
hedges away from claiming anything ("1800R might be less immersive
but content might look less distorted") commits to nothing — even
though it names two aspects.

  - high — commits AND is specific. Names the condition, symptom,
    comparison, or context that lets the buyer reason about their
    own situation. Strong purchase outcomes ("had to return it")
    qualify on their own. Well-articulated prospective concerns
    count when they name a specific condition ("worried about
    G-Sync at 240Hz with HDR since the panel isn't certified").

  - medium — commits but stays generic. A real evaluation or
    reaction, but brief, single-attribute, or unconditional:
    "love it", "amazing colors", "the curve is perfect", "highly
    recommend", "I wish I'd bought it sooner", "5ms response
    time" (spec without condition).

  - low — does not commit. Hedged speculation ("might…", "is said
    to…"), hearsay ("people online say…"), the speaker's own
    indecision ("unsure if I need 240Hz"), forward-looking intent
    ("I'll buy it next month"), logistics ("just bought it for
    $750"), settings ("brightness at 54"), brand trust without
    reasoning ("I trust LG"), or content too vague to convey
    anything ("looks great on specs", "feels like a gamble").

Decision procedure for each quote:
  1. Does it commit (a/b/c/d above)? If no → low.
  2. Is the commitment specific (names a condition, symptom,
     comparison, or context)? If no → medium. If yes → high.

Mixed quotes are judged on their strongest committing clause.

Rich evidence does not imply high quality — a quote can produce
multiple features/issues and still be medium if every clause is
brief. Quality reads from the text, not the evidence count.

Do NOT downgrade for stance. A prospective-buyer concern that
commits to a specific condition is high; the quote-level
\`speculative\` flag and experience tier handle stance at display
time.

${SECTION_RULE}
STEP 5 — REFERENCE DETAILS
${SECTION_RULE}

Per ref, populate referenceDetails ONLY when the comment explicitly states:

- returned: true — author says they returned, sent back, or refunded.
- defective: true — author describes a physical defect (dead pixel, coil
  whine, panel fault). NOT for settings issues, software bugs.
- multipleUnits: true — author tested or owned 2+ units of this exact
  model.

Omit referenceDetails entirely when nothing applies. Do not guess.

${SECTION_RULE}
STEP 6 — REFERENCE-LEVEL EVIDENCE
${SECTION_RULE}

Most labels live on quotes. Sometimes a claim only becomes visible by
reading ACROSS quotes — no single quote alone evidences it, but the
combination of quotes inside one reference does. Capture those on the
ref via a \`referenceLabels\` block:

  - referenceLabels.features[]: cross-quote feature evidence.
  - referenceLabels.useCases[]: cross-quote use-case evidence.

Both reuse the FEATURES and USE CASES vocabularies — the set of allowed
labels does not change. Each entry is \`{label, sentiment}\` like quote
evidence.

The canonical example is \`dual use\` (USE CASES vocabulary): emit on the
REF when one quote evidences a work-lens (office / programming /
finance / heavy multitasking / etc.) AND another quote evidences a
gaming-lens (PC gaming / immersive gaming / competitive FPS / etc.) for
the same product. A single quote that says "good for work and games"
does NOT earn \`dual use\` — that quote gets BOTH a work use-case AND a
gaming use-case at the quote level. \`dual use\` is strictly for the
cross-quote pattern.

Rules:

  - Do NOT duplicate labels already supported by a single quote. If a
    quote already evidences "office", do not also emit "office" in
    referenceLabels.useCases for the same ref. Ref-level evidence is
    additive; it must contribute information that quote-level evidence
    cannot.
  - Ref-level evidence is ALWAYS confirmed. Never emit ref-level
    evidence for hedged, hearsay, or future-tense claims. If a claim
    needs a speculative flag, it belongs on a quote.
  - Issue evidence is per-quote ONLY. Never put closed-list issue labels
    in referenceLabels.features.
  - Set sentiment explicitly on every ref-level entry; there is no
    enclosing quote to inherit from.

Omit \`referenceLabels\` entirely (do not emit an empty object) when no
cross-quote signal applies. This is the common case.

${SECTION_RULE}
SPECULATIVE
${SECTION_RULE}

Set \`speculative: true\` on the QUOTE (not per evidence) when the
WHOLE quote is hedged or the speaker has NOT first-hand experienced
what the quote describes:

- "I'm worried about burn-in" — owner speculating about future.
- "I heard the colors are amazing" — hearsay.
- "I'd expect / supposed to / might be / people say".
- experience='reference' speakers relaying claims about the product —
  no first-hand contact, so the quote is speculative.

Ownership does NOT make every statement first-hand. An owner worrying
about future burn-in is still speculating.

Opinion-qualifiers ("I think", "I feel", "to me", "imo") on first-hand
observations are NOT speculative — they mark a subjective verdict from
direct use, not a guess.

Stance applies to the whole quote: every evidence entry on a
speculative quote shares that stance — that is why the flag lives on
the quote rather than on individual features/useCases/issues. Omit the
field (or set it to false) when the quote is a first-hand observation.

${SECTION_RULE}
OUTPUT
${SECTION_RULE}

\`\`\`json
{
  "products": [
    {
      "productId": "Ba",
      "quotes": [
        {
          "quoteIndex": 0,
          "quality": "high",
          "issues": [{ "label": "vrr black screen", "sentiment": "strongNegative" }]
        },
        {
          "quoteIndex": 1,
          "quality": "low"
        }
      ],
      "referenceDetails": { "returned": true }
    },
    {
      "productId": "Bb",
      "quotes": [
        {
          "quoteIndex": 0,
          "quality": "medium",
          "speculative": true,
          "features": [{ "label": "colors" }]
        }
      ]
    },
    {
      "productId": "Ca",
      "quotes": [
        {
          "quoteIndex": 0,
          "quality": "high",
          "useCases": [{ "label": "office", "sentiment": "positive" }]
        },
        {
          "quoteIndex": 1,
          "quality": "high",
          "useCases": [{ "label": "immersive gaming", "sentiment": "positive" }]
        }
      ],
      "referenceLabels": {
        "useCases": [{ "label": "dual use", "sentiment": "positive" }]
      }
    }
  ]
}
\`\`\`

Include EVERY input productId in products[]. EVERY quote on every
product appears in quotes[] with its quality tier (STEP 4). Evidence
streams (features/useCases/issues) are only added when STEP 1, STEP 2,
or STEP 3 produced at least one entry. \`referenceLabels\` is added per
STEP 6 only when a cross-quote signal applies; it is omitted entirely
otherwise.

${vocabularySections.join("\n\n")}${examplesBlock}`;
}
