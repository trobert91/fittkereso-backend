import { ThreadCategoryConfig } from '../models/thread-context';
import { SENTIMENT_TIERS_RUBRIC } from './sentiment-tiers.prompt';
import { renderValidSpec } from './valid-specs.renderer';

// ─── Default extraction example ──────────────────────────────────────────────

const DEFAULT_EXTRACTION_EXAMPLES = `{
  "comments": [
    {
      "NOTE": "c0: OP-style buyer deliberation under a section header followed by 5 bullets. ONE quote per bullet (rule 3). The section header is dropped. Sentiment per default-neutral rule: grey-tint con named → negative. Thinner bezels pro named → positive. The QC impression and the G-sync expectation mention the product but claim no actual pro or con → neutral.",
      "commentId": "c0",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "I am concerned about the \\"grey tint\\" on a glossy-QD-OLED", "sentiment": "negative" },
            { "text": "800R curve could be very immersive in games but I am concern regular content like videos or photos might look too distorted", "sentiment": "mixed" },
            { "text": "Thinner bezels and better looking design", "sentiment": "positive" },
            { "text": "LG just gives me the impression of better QC than the other", "sentiment": "neutral" },
            { "text": "Certified G-sync compatible. So, I'd expect it to work better than the non-certified ones", "sentiment": "neutral" }
          ],
          "experience": "prospective_buyer",
          "depth": "comprehensive",
          "intents": ["comparison", "seeking_advice"],
          "overallSentiment": "mixed"
        }
      ]
    },
    {
      "NOTE": "c1: Owner with strong but informal verdicts. None of these are in any 'verdict vocabulary' — they are still kept because a buyer reading them cold would learn the speaker loves the monitor.",
      "commentId": "c1",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "all I can say is wow", "sentiment": "positive" },
            { "text": "This monitor is absolutely insane", "sentiment": "positive" },
            { "text": "I wish I had bought it sooner", "sentiment": "positive" }
          ],
          "experience": "owner",
          "depth": "mentioned",
          "intents": ["experience_report", "recommendation"],
          "overallSentiment": "positive"
        }
      ]
    },
    {
      "NOTE": "c2: Reference-tier external info. Identification claim is informational with no pro/con → neutral. Firmware fix + 'no other monitor has done' is a pro → positive.",
      "commentId": "c2",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "TFT says its the MSI 341CQPX", "sentiment": "neutral" },
            { "text": "they just released firmware which fixes the HDR which no other monitor in this field has done", "sentiment": "positive" }
          ],
          "experience": "reference",
          "depth": "detailed",
          "intents": ["reputation_report", "comparison"],
          "overallSentiment": "positive"
        }
      ]
    },
    {
      "NOTE": "c3: Multi-product comparison (rule 4). Comparative clauses attach to BOTH products, but each side's sentiment is judged from what the clause says about THAT side. 'better panel at a lower price' → MSI positive (pros named); LG negative because 'better panel' explicitly names LG's panel as worse. 'a lot more issues reported than the LG' → MSI mixed (great specs pro + issues con); LG positive (fewer issues = pro). Clauses naming only one product (G-sync concern, certification, gamble) stay on that product. Same verbatim substring under both is the intended shape for genuine comparisons.",
      "commentId": "c3",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "I also lean more toward the MSI as it offers a better panel at a lower price", "sentiment": "positive" },
            { "text": "I'm mostly concerned about G-sync since the panel is not certified", "sentiment": "negative" },
            { "text": "It looks great on specs but I'm also seeing a lot more issues reported than the LG", "sentiment": "mixed" },
            { "text": "Feeling like a huge gamble is what's making me hesitate atm", "sentiment": "neutral" }
          ],
          "experience": "prospective_buyer",
          "depth": "comprehensive",
          "intents": ["comparison", "seeking_advice"],
          "overallSentiment": "mixed"
        },
        {
          "productIndex": 1,
          "quotes": [
            { "text": "I also lean more toward the MSI as it offers a better panel at a lower price", "sentiment": "negative" },
            { "text": "It looks great on specs but I'm also seeing a lot more issues reported than the LG", "sentiment": "positive" },
            { "text": "The LG panels are at least certified", "sentiment": "positive" }
          ],
          "experience": "prospective_buyer",
          "depth": "detailed",
          "intents": ["comparison"],
          "overallSentiment": "positive"
        }
      ]
    },
    {
      "NOTE": "c4: Prior-owner issue report. Multiple distinct issue clauses → multiple quotes. The acquisition ('I had to return it') merges with the symptom into one issue narrative; the troubleshooting attempt ('I tried 3 DP cables') is buyer-useful because it documents how thoroughly the issue was reproduced.",
      "commentId": "c4",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "when I enabled G-Sync, I had black screen flickers (not OLED flicker), it looked like losing a signal or something", "sentiment": "negative" },
            { "text": "I had to return it", "sentiment": "negative" },
            { "text": "I have tried 3 DP cables and two HDMI. Result was the same", "sentiment": "negative" },
            { "text": "It had black screen flickers several times per 10 seconds. So it wasnt usable for me while paying so much money for it", "sentiment": "negative" }
          ],
          "experience": "prior_owner",
          "depth": "comprehensive",
          "intents": ["issue_report", "warning"],
          "overallSentiment": "negative"
        }
      ]
    },
    {
      "NOTE": "c5: Owner with weak signal. 'No greats so far' is a real (if understated) verdict and stays. Acquisition ('my local micro center had the LG Ultragear on sale') drops.",
      "commentId": "c5",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "No greats so far", "sentiment": "neutral" }
          ],
          "experience": "owner",
          "depth": "mentioned",
          "intents": ["experience_report"],
          "overallSentiment": "neutral"
        }
      ]
    },
    {
      "NOTE": "c6: Two-product comment with empty product. The speaker evaluates only the LG (the resolved p0). The MSI is named but only as a baseline ('unlike the MSI') with no real evaluation — p1 gets an empty entry.",
      "commentId": "c6",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "the matte finish handles bright rooms way better than glossy panels", "sentiment": "positive" }
          ],
          "experience": "prospective_buyer",
          "depth": "detailed",
          "intents": ["recommendation", "comparison"],
          "overallSentiment": "positive"
        },
        {
          "productIndex": 1,
          "quotes": [],
          "experience": "reference",
          "depth": "superficial",
          "intents": [],
          "overallSentiment": "neutral"
        }
      ]
    },
    {
      "NOTE": "c7: Acquisition + verdict + named-attribute con. Drop the acquisition. Panel pro → positive. The counterfactual 'if it had Android instead of Tizen it would be awesome' names a con on current software (Tizen worse than Android) → negative.",
      "commentId": "c7",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "the panel is great", "sentiment": "positive" },
            { "text": "if it had Android instead of Tizen it would be awesome", "sentiment": "negative" }
          ],
          "experience": "owner",
          "depth": "detailed",
          "intents": ["experience_report"],
          "overallSentiment": "mixed"
        }
      ]
    },
    {
      "NOTE": "c8: Self-contained widening. The verdict clause 'I've been perfectly fine without it' is meaningless alone — 'it' refers to FreeSync from the prior clause. Widen the substring to include the antecedent so the quote stands on its own.",
      "commentId": "c8",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "I haven't really used the FreeSync that the monitor comes with, I've been perfectly fine without it", "sentiment": "neutral" }
          ],
          "experience": "owner",
          "depth": "mentioned",
          "intents": ["experience_report"],
          "overallSentiment": "neutral"
        }
      ]
    },
    {
      "NOTE": "c9: Meta-commentary dual-attaches (rule 4) but neutral on BOTH — the clause evaluates the reviews/discourse, not the products themselves, so no pro or con is claimed about either side.",
      "commentId": "c9",
      "products": [
        {
          "productIndex": 0,
          "quotes": [
            { "text": "Most youtube and website reviews like Rtings favor the MSI but on Reddit I seem to find more issues reported than the LG", "sentiment": "neutral" }
          ],
          "experience": "prospective_buyer",
          "depth": "mentioned",
          "intents": ["reputation_report", "comparison"],
          "overallSentiment": "neutral"
        },
        {
          "productIndex": 1,
          "quotes": [
            { "text": "Most youtube and website reviews like Rtings favor the MSI but on Reddit I seem to find more issues reported than the LG", "sentiment": "neutral" }
          ],
          "experience": "prospective_buyer",
          "depth": "mentioned",
          "intents": ["reputation_report", "comparison"],
          "overallSentiment": "neutral"
        }
      ]
    }
  ]
}`;

// ─── Prompt body builder ──────────────────────────────────────────────────────

function buildExtractionPromptBody(): string {
  return `You extract buyer-useful quotes from Reddit comments about pre-resolved
product references.

Imagine the reader: someone who is considering buying THIS product right
now. They will read your quotes one by one, with no surrounding comment.
Every quote you keep should help them decide — by telling them something
the product is, does, fails at, costs, or feels like, or by giving them
a real opinion from someone who has used it, returned it, or is weighing
it up. Quotes that don't help that reader are noise; drop them.

Recall over trimming when in doubt. If you genuinely can't tell whether
a clause helps the buyer, keep it.

── INPUT ─────────────────────────────────────────────────────────────────────

- A resolved-products section listing each comment's products as p0, p1, …,
  with real specs from the database.
- The cheat sheet and OP summary for context.
- [PLAN] comments with short IDs c0, c1, ….

── WHAT TO PRODUCE ───────────────────────────────────────────────────────────

For every [PLAN] comment × product, produce:
- quotes: verbatim substrings of the comment body that evaluate THIS product,
  each with a \`text\` and \`sentiment\`. Do NOT emit a \`features\` field on
  quotes — feature/use-case labelling is a separate downstream step and
  anything you write here will be discarded.
- specs: spec values the commenter states for THIS product (optional).
- experience: owner | prior_owner | tested | prospective_buyer | reference
- depth: comprehensive | detailed | mentioned | superficial
- intents: up to two of recommendation, issue_report, comparison,
  experience_report, warning, seeking_advice, question, reputation_report
- overallSentiment: strongPositive | positive | neutral | negative | strongNegative | mixed

Process EVERY product in the resolved list for the comment, even if the
comment barely mentions it. When the comment says nothing about a product
beyond naming it, emit quotes: [] and depth: "superficial". Never invent
products that are not in the resolved list.

── BUYER-USEFUL TEST ────────────────────────────────────────────────────────

Read each candidate substring on its own. A buyer who has never seen
the rest of the comment must learn at least one of:

  • a real opinion on the product — "absolutely insane", "huge upgrade",
    "I just couldn't deal with the blooming", "no greats so far",
    "feels just right", "wish I'd bought it sooner".
  • something concrete about the product — an attribute, behavior,
    feature, defect, spec, comparison, or informational claim.
    ("HDR is amazing in various games that have it", "had to return
    it", "thinner bezels than the others", "certified G-sync compatible",
    "TFT says it's the MSI 341CQPX".)
  • a subjective value-quality assessment that holds across markets —
    "great value", "overpriced", "good for the money", "feels expensive
    but worth it", "not worth the premium". These are real evaluations
    of the price-to-product relationship, not raw price data, so they
    travel across currencies/regions.
  • a reasoned stance the buyer can weigh — a concern, preference, or
    deliberation grounded in a basis. ("Concerned about the grey tint
    on a glossy-QD-OLED", "torn between 800R and 1800R", "biggest
    concern is G-sync since the panel isn't certified", "feels like a
    huge gamble because of all the issues reported".)

The verb does not have to be a strong adjective. "Concerned about",
"torn between", "lean toward", "I'd expect", "looks great on specs
but" all qualify when paired with a named attribute or a basis.

Reference-tier external info keeps when it describes a real attribute
of THIS product. The downstream labeller handles speculative vs.
first-hand on its own — do NOT drop a quote because the speaker is
a prospective buyer or relaying others' reports.

A clause fails the test when it carries none of the three above —
typically because it is hedge-only ("might be good"), hearsay-only
("people say it's nice"), pure indecision ("not sure if I need
240Hz"), bare brand-trust ("I trust LG"), logistics, settings, or
off-topic. The ALWAYS DROP list below catalogs the common failures.

── ALWAYS DROP ──────────────────────────────────────────────────────────────

These never produce quotes, even when adjacent to a surviving clause
(keep the surviving clause, drop the rest):

- Acquisition / logistics: "I bought X", "got it Tuesday", "arrives
  tomorrow", "picked it up", "just received", "ordered it".
- Absolute prices and cross-market price comparisons: bare currency
  amounts ("$999", "1,500 AUD", "for 600 EUR", "$750"), regional or
  temporal comparisons ("cheaper here than there", "$999 USD then $999
  AUD now", "great deal at $X"), and store-specific deals. These don't
  translate across currencies, regions, or time and aren't stable
  buyer-useful signals.

  KEEP subjective value-quality assessments that hold across markets:
  "great value", "overpriced", "good for the money", "fair price for
  what you get", "not worth the premium". Also keep structural
  comparisons anchored on a product attribute ("X has more features
  than Y at the same MSRP" — the basis is features, not price).
- Future-tense intent: "I will test", "I'll let you know", "I'll add
  a video later".
- Settings / method dumps with no verdict: "brightness 54, contrast 70",
  "pumped all settings to ultra" (alone). When a verdict follows
  ("pumped it to ultra and it was insane"), keep the verdict clause.
- Speaker-tuning meta-claims with no product-side content: "I found
  the perfect settings", "got it dialed in", "finally tuned it right".
  Keep clauses that name what the tuning achieved on the product.
- Pure questions to other users: "does X work at Y?", "anyone tried it?".
- Single-word reactions: "Nah", "yes", "exactly", "lol".
- Pure off-topic: shipping, payment, cable troubleshooting, unrelated
  product chatter.
- Clauses purely about another product — the "coming from" device, a
  store demo, a future variant the speaker is NOT evaluating. ("Coming
  from a 165Hz Acer Predator IPS" drops; the comparison clause that
  USES that baseline — "it feels smoother and the colors are crazy" —
  keeps and attaches to the resolved product.)
- Section headers and bullet markers themselves: "My thoughts on
  Product A:", "* ", "- ". The header's content does not become a
  quote; the bullets underneath do.
- Hedge-only / hearsay-only / indecision-only clauses with no specific
  basis. (See BUYER-USEFUL TEST.)
- Vague brand-trust without reasoning: "I trust LG", "Samsung is the
  best brand". A reasoned version — "I trust LG because it's the panel
  manufacturer" — keeps.

── QUOTE RULES ──────────────────────────────────────────────────────────────

1. Every quote is a verbatim substring of the comment body (indexOf-safe).
   Trim from edges only; never paraphrase, never stitch non-adjacent text.
   You MAY skip a leading bullet/list marker ("* ", "- ", "• ", "1. ")
   so the quote begins on the first prose character.

2. Take the smallest substring that stands alone as a complete thought.
     • If the surviving clause uses a pronoun ("it", "that", "them") or
       elliptical reference ("the same", "didn't bother", "returned it",
       "fine without it") whose antecedent is in the immediately
       adjacent clause of the same sentence, include the antecedent.
       Examples:
         - "I haven't really used the FreeSync that the monitor comes
           with, I've been perfectly fine without it" — keep both;
           "it" refers to FreeSync.
         - "The stand wobbles. I returned it" — keep both; otherwise
           "I returned it" floats.
     • Do NOT cross sentence-final punctuation, bullet/list markers,
       blank lines, or section-header colons. Each bullet, sentence,
       and paragraph is its own quote candidate.
     • Do NOT invent context. If the speaker did not place a condition
       or scenario next to the verdict, leave the verdict bare.

3. ONE quote per distinct evaluation. A 5-bullet list of considerations
   becomes 5 quotes, not 1. A two-clause comment evaluating two
   attributes becomes 2 quotes. Don't bundle.

4. Per-product attribution. Attach a quote to product P only when the
   substring ITSELF evaluates P — explicitly, or by an EXPLICIT
   comparison naming P. Do not attach by implication or inference.
     • "X is better than Y at A" → attach to BOTH X and Y. Both
       products are explicitly evaluated by the comparison. Sentiment:
       positive on X, negative on Y. Same verbatim substring under
       both.
     • "X is faster but Y has more ports" → attach to BOTH. Each
       product is explicitly evaluated. Sentiment per product reflects
       its side of the tradeoff. Either reuse the full substring under
       both, or split into clause-level substrings if cleaner per
       product.
     • "Both X and Y are great" → attach to BOTH, positive on each.
     • "X is certified" with Y nearby but unmentioned → attach to X
       ONLY. The substring does not predicate anything on Y;
       inferring "Y is therefore not certified" is reasoning beyond
       the text.
     • A clause that mentions a product purely as a baseline ("unlike
       the MSI", "compared to my old IPS") does NOT attach to the
       baseline — only to the product being evaluated against it.
     • When a comment evaluates only ONE of the listed products, the
       other gets quotes: [] and depth: "superficial".

5. Each quote text appears at most ONCE per product. Across products,
   the same verbatim substring MAY appear under multiple products
   when rule 4 attributes it to each — that is the intended shape
   for comparative clauses, not a duplication error.

6. Cross-check the quote against the resolved product's specs. If the
   quote names an attribute value (panel type, screen size, refresh
   rate, curve, resolution, category-specific spec) that contradicts
   the resolved product:
     - If a different resolved product in this comment matches →
       reattach.
     - If no resolved product matches → drop the quote.
   Section headers never override the quote's actual content.

7. Merge a "concern → resolved" pattern ("worried about X but in
   practice fine") into ONE quote with the net sentiment.

8. Per-product ceiling: 8. Per-comment ceiling across all products: 16.
   When a comment exceeds the ceiling, prefer quotes naming distinct
   attributes over near-duplicates of the same point.

9. If no quotes survive for a product, emit quotes: [] and depth:
   "superficial". Do not pad.

── SENTIMENT PER QUOTE ──────────────────────────────────────────────────────

Default is neutral. Judge from THIS quote's wording alone — not the
speaker's overall stance.

${SENTIMENT_TIERS_RUBRIC}

For comparatives, judge each side from what the clause says about THAT
side:
  - "X is better value than Y" → X positive (value pro), Y neutral (no con
    claimed about Y).
  - "X has a better panel than Y" → X positive, Y negative.
  - "X is dramatically better than Y, no contest" → X strongPositive,
    Y strongNegative.

── SPECS — apply per ref ────────────────────────────────────────────────────

For each ref, check: did the commenter state a spec value for THIS product
that (a) is in the valid spec keys for this product's category and (b)
differs from the resolved-products entry?

If yes → add { name, value }. If no → omit specs.

Never extract specs from: "coming from" clauses, parent-comment quotes,
the OP's personal requirements, settings dumps.

── CLASSIFICATION ───────────────────────────────────────────────────────────

experience (pick the highest tier that applies):
- owner — any clear evidence of purchase or current possession: "I bought",
  "I got", "I've had it", "just received", "picked up", "I have the X",
  "I own". Still owner when testing, calibrating, or considering a return.
- prior_owner — bought and returned, sold, or upgraded away: "I had that
  X and returned it", "I used to own".
- tested — used without purchase: store demo, friend's unit, trial.
- prospective_buyer — researching, deliberating, no physical contact.
  Dominant tier in OP-style buyer-deliberation comments.
- reference — relaying external info with no stake (citing reviews,
  benchmarks, third-party sources, "TFT says…", "Rtings favors…").

depth:
- comprehensive — 3+ distinct attributes with specifics or reasoning.
- detailed — at least one specific observation with reasoning, context,
  or a named attribute.
- mentioned — a verdict or feature named without reasoning.
- superficial — no buyer-useful content survived; quotes is empty.

If quotes is empty, depth is "superficial". If 3+ surviving quotes name
distinct attributes, depth is at least "detailed", usually "comprehensive".

overallSentiment: net stance across all surviving quotes on this product.
Pick from the same 6-value scale used for per-quote sentiment. A comment
with one positive and one negative attribute is "mixed". When the
surviving quotes are uniformly enthusiastic (mostly strongPositive) or
uniformly severe (mostly strongNegative), promote overallSentiment to
the strong tier; otherwise keep it at positive/negative.

intents (up to 2): pick the strongest match.
- recommendation / anti-recommendation framing → "recommendation" or
  "warning"
- buying-decision deliberation → "comparison" + "seeking_advice"
- first-hand usage report → "experience_report"
- defect/problem report → "issue_report"
- relaying others' reports → "reputation_report"

── OUTPUT ───────────────────────────────────────────────────────────────────

One entry per [PLAN] comment using its exact short ID. productIndex
references the resolved product list for that comment. Process ONLY the
products in the resolved list — do not invent products beyond what is
listed there.`;
}

// ─── Dynamic SCOPE builder ────────────────────────────────────────────────────

function buildScopeSection(categoryConfigs: ThreadCategoryConfig[]): string {
  if (categoryConfigs.length === 0) {
    return `── SCOPE ──────────────────────────────────────────────────────────────────────

Extract content for products from all categories. No category-specific spec
keys defined.`;
  }

  const categoryLines = categoryConfigs.map((config) => {
    const validSpecs = config.promptConfig.validSpecs;
    const validSpecsStr = validSpecs?.length
      ? `\n  Valid spec keys:\n${validSpecs.map((s) => renderValidSpec(s)).join('\n')}`
      : '';
    const instruction = config.promptConfig.specialInstructions
      ? `\n  ${config.promptConfig.specialInstructions}`
      : '';
    return `- ${config.categoryName}${validSpecsStr}${instruction}`;
  });

  return `── SCOPE ──────────────────────────────────────────────────────────────────────

This thread focuses on:
${categoryLines.join('\n')}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveExamples(categoryConfigs: ThreadCategoryConfig[]): string {
  const topCategoryExamples =
    categoryConfigs[0]?.promptConfig.extractionExamples;
  return topCategoryExamples
    ? JSON.stringify(topCategoryExamples, null, 2)
    : DEFAULT_EXTRACTION_EXAMPLES;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildExtractionSystemPrompt(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  const body = buildExtractionPromptBody();
  const scope = buildScopeSection(categoryConfigs);
  const examples = resolveExamples(categoryConfigs);
  return `${body}

${scope}

── EXAMPLE ───────────────────────────────────────────────────────────────────

${examples}`;
}
