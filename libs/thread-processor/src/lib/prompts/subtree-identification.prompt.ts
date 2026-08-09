import { CategoryPromptConfig } from "@ebike-backend/database";
import { ThreadCategoryConfig } from "../models/thread-context";
import { renderValidSpec } from "./valid-specs.renderer";

// ─── Category-aware section builders ──────────────────────────────────────────

function buildProductIdSection(promptConfig: CategoryPromptConfig): string {
  const examples = promptConfig.productIdExamples;
  if (examples?.length) {
    const lines = examples.map(
      (e) => `  "${e.mentioned}" → brand: "${e.brand}", model: "${e.model}"`,
    );
    return lines.join("\n");
  }
  return `  "Brand ProductLine ModelNumber" → brand: "Brand", model: "ProductLine ModelNumber"`;
}

function buildTechDescriptorList(promptConfig: CategoryPromptConfig): string {
  const descriptors = promptConfig.technologyDescriptors;
  return descriptors?.length
    ? descriptors.join(", ")
    : "technology types, driver types, connector standards";
}

function buildTechDescriptorSection(
  promptConfig: CategoryPromptConfig,
): string {
  return `Tech terms alone (${buildTechDescriptorList(promptConfig)}) are not products. Only emit when attached to a brand or model.`;
}

const DEFAULT_IDENTIFICATION_EXAMPLES: Record<string, unknown> = {
  comments: [
    {
      commentId: "c0",
      products: [
        {
          type: "explicit",
          brand: "Brand",
          model: "Model123",
          contentQuality: "high",
        },
      ],
    },
    { commentId: "c1", products: [] },
  ],
};

function buildIdentificationExamplesSection(
  promptConfig: CategoryPromptConfig,
): string {
  const examples =
    promptConfig.identificationExamples ?? DEFAULT_IDENTIFICATION_EXAMPLES;
  return `─────────────────────────────────────────────────────────────────────────────
EXAMPLES
─────────────────────────────────────────────────────────────────────────────

${JSON.stringify(examples, null, 2)}`;
}

// ─── Scope section ────────────────────────────────────────────────────────────

function buildIdentificationScopeSection(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  if (categoryConfigs.length === 0) {
    return `── SCOPE ──────────────────────────────────────────────────────────────────────

Identify product references from all categories.
categoryHint: the product's general category if identifiable, otherwise omit.`;
  }

  const categoryLines = categoryConfigs.map((config) => {
    const validSpecs = config.promptConfig.validSpecs;
    const validSpecsStr = validSpecs?.length
      ? `\n  Valid spec keys:\n${validSpecs.map((s) => renderValidSpec(s)).join("\n")}`
      : "";
    const instruction = config.promptConfig.specialInstructions
      ? `\n  ${config.promptConfig.specialInstructions}`
      : "";
    return `- ${config.categoryName}${validSpecsStr}${instruction}`;
  });

  return `── SCOPE ──────────────────────────────────────────────────────────────────────

This thread focuses on:
${categoryLines.join("\n")}

categoryHint: use the exact focus category name (e.g. "${categoryConfigs[0]?.categoryName ?? "Products"}").`;
}

// ─── Prompt body builder ──────────────────────────────────────────────────────

function buildIdentificationPromptBody(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  const topConfig = categoryConfigs[0]?.promptConfig ?? {};

  const productIdExamples = buildProductIdSection(topConfig);
  const techDescriptorList = buildTechDescriptorList(topConfig);
  const techDescriptors = buildTechDescriptorSection(topConfig);
  const identificationExamples = buildIdentificationExamplesSection(topConfig);

  return `You identify which products each Reddit comment references.

── INPUT ─────────────────────────────────────────────────────────────────────

- A cheat sheet of products already seen in this thread, each tagged
  [primary], [secondary], or [mentioned].
- The original post for context.
- A tree of comments. [PLAN] c0, c1, … need a result. [CONTEXT] nodes are
  shown only so you can resolve references — do NOT output results for them.
  Each [CONTEXT] node shows [products: …] listing what was already extracted.
- Each comment shows depth [d:N] and optionally [owns: …] or [used: …].

── OVERVIEW ──────────────────────────────────────────────────────────────────

For every [PLAN] comment, work through three steps, then classify each
product reference as explicit or referenced (Step 5).

  STEP 1 — Which products are referenced?
  STEP 2 — What is the contentQuality for each?
  STEP 3 — What specs did this commenter state?
  STEP 5 — Is this an explicit identification or a back-reference?

Output one entry per [PLAN] comment using its exact short ID (c0, c1, …).

─────────────────────────────────────────────────────────────────────────────
STEP 1 — IDENTIFY PRODUCTS
─────────────────────────────────────────────────────────────────────────────

Walk every [PLAN] comment through this procedure top-to-bottom.

── 1. Find the product reference ─────────────────────────────────────────────

Scan the comment for, in order:
  (a) an explicit model token,
  (b) a bare brand reference,
  (c) a bare tech term (${techDescriptorList}),
  (d) a pronoun / "it" / "mine" continuation,
  (e) nothing.

── 2. Resolve to a model field ───────────────────────────────────────────────

  GUARD — Explicit token blocks parent-context resolution. If the comment
  contains an explicit alphanumeric model token (≥4 chars, ≥1 letter,
  ≥1 digit — e.g. \`341CQP\`, \`34GP83A-B\`, \`PG34WCDM\`), only paths 2.1, 2.2,
  or 2.4 apply. Path 2.3 (parent context) is forbidden — anaphoric phrases
  like "sister to yours" or "same as yours" do NOT relabel the explicit
  token; they merely point at the parent's product alongside the
  commenter's distinct one.

  1. Explicit model token that matches a cheat-sheet entry as a whole-token
     equivalent (exact name, registered abbreviation, registered
     disambiguator, OR an obvious misspelling of the entry — same overall
     shape, off by a few characters from a clear slip like a drop, swap,
     repeat, or transposition) → emit the cheat-sheet model. Substring
     matches that differ by any suffix/prefix character or generation marker
     do NOT qualify here — those go to 2.2.
  2. Explicit model token that does NOT match any cheat-sheet entry as a
     whole-token equivalent → emit verbatim. When multiple cheat-sheet
     entries are textually similar, pick the entry whose model code aligns
     most exactly with the comment's token (longest exact alignment with
     no character mismatch); if no entry aligns exactly, emit the
     commenter's spelling verbatim.
  3. Comment provides only a brand, tech term, pronoun, or implicit
     continuation about a product (no explicit model token), AND the
     comment IS substantively about a product (logistics, ownership,
     verdict, question about it, comparison) → resolve via, in order:
       (a) parent [CONTEXT] node's [products: …];
       (b) same author's earlier comments in this subtree (logistics,
           ownership, verdicts, issue reports keep the chain alive — only
           an explicit topic shift breaks it);
       (c) PLAN ancestor that established a product;
       (d) a single cheat-sheet entry uniquely picked out by what the
           comment provides — one entry matches the named brand, OR one
           entry matches the named tech term, OR (when multiple share
           that brand or tech term) one entry uniquely matches a stated
           spec value.
     Use that entry's cheat-sheet model.
  4. Comment carries no product reference (content-free reaction like
     "Nah" / "lol" / "thanks" / "huge gamble"; pure meta-reply about the
     conversation; question or hypothetical with no concrete product
     referent; bare brand/tech term with no discriminator and 2+ matching
     entries; speculation about a future variant) → products: [].

  When in doubt between 2.3 and 2.4, prefer 2.4. A reply that exists in a
  product-discussion chain but says nothing about any product is a 2.4
  case — do NOT inherit the parent's product just because the chain has
  one.

── 3. Specs vs. SKU split ────────────────────────────────────────────────────

Once a cheat-sheet model is chosen via 2.1 or 2.3, a stated spec value
that diverges from the entry's known specs (size, refresh rate,
technology type, curvature, etc.) goes into specs — NOT into model.
Only an SKU-token divergence (different model-name token) keeps the
emission verbatim under 2.2.

── Notes ─────────────────────────────────────────────────────────────────────

When splitting a mention into brand + model:
${productIdExamples}

brand: manufacturer name only.

${techDescriptors}

Deduplication: if one comment names the same product twice with different
text, emit it once using the resolved model. Different SKUs that look similar
but differ in any character are different products — emit both.

─────────────────────────────────────────────────────────────────────────────
STEP 2 — CONTENT QUALITY
─────────────────────────────────────────────────────────────────────────────

Score the richness of the review content itself — NOT how confidently the
product was identified. A comment can have uncertain product identification
(unclear model, hedged clue) AND rich review content; these are independent.

- high — substantive evaluation: specific feature feedback, detailed
  first-hand experience, reasoned comparison or recommendation.

- medium — a verdict or preference without supporting depth (short praise,
  short dismissal, a single-clause verdict, anti-recommendation WITH a
  reason).

- low — product named but not evaluated: bare ownership, bare logistics,
  reaction that names a product, listed without comment, availability remark,
  anti-recommendation with NO reason, a question or hypothetical that names
  a product, future-action / purchase intent.

When borderline, pick the LOWER level.

─────────────────────────────────────────────────────────────────────────────
STEP 3 — SPECS
─────────────────────────────────────────────────────────────────────────────

Emit a spec only when the commenter's own text states a value that describes
THIS product's capability or physical property. Do NOT emit a spec when:
- it reflects the commenter's hardware constraint, not the product's spec,
- it appears in a "coming from" / "upgrading from" clause about a previous
  device,
- it is only stated in the OP post (when the commenter is not the OP),
- it is only present in the parent [CONTEXT] node — do not copy parent specs
  into the [PLAN] entry.

Use only the valid spec keys listed under SCOPE. If the commenter states
multiple valid specs for this product, emit all of them.

─────────────────────────────────────────────────────────────────────────────
STEP 4 — REFERENCE MODEL AND CLUES
─────────────────────────────────────────────────────────────────────────────

When the comment refers to a product already shown in the cheat sheet:

  referenceModel: Copy the catalog model token verbatim from the cheat-sheet
    line (e.g. "34GS95QE-B"). Also set brand from the section header above
    that line (e.g. "LG" from "LG:"). Only copy from a line that has a real
    catalog model — never copy from lines tagged "(unresolved)".

  modelClues: Partial model codes or tokens the user wrote that do NOT match
    the cheat-sheet entry exactly (e.g. ["G8sd"]). A token that is clearly a
    misspelling of the cheat-sheet entry — same overall shape, off by a few
    characters from an obvious slip (drop, swap, repeat, transposition) — is
    NOT a clue; treat it as the entry itself (Step 2 path 2.1) and leave it
    out of modelClues. Omit when no model token appears in the comment. Omit
    when model is already set.

  variantClues: Free-form distinguishing traits that do NOT fit a structured
    spec name (e.g. ["full-size ports", "black remote", "Tizen OS",
    "newer version"]). Use specs for traits with a structured spec equivalent
    (screenSize, refreshRate, panelType, curvature, etc.) — not variantClues.

  HARD RULE: Do not guess SKUs. Record the observed reference, model
  fragments, and clues. Resolution will pick the actual product.

  modelClues and variantClues only matter when referenceModel is set — omit
  them when referenceModel is absent.

  Same vs. variant is inferred by resolution — you do not declare it. Just
  record what the user said: referenceModel + any model fragments + any
  traits. If specs match the anchor's known specs and you add no clues,
  resolution treats the comment as same-as. If specs differ or clues are
  present, resolution treats it as a variant.

─────────────────────────────────────────────────────────────────────────────
STEP 4 EXAMPLES
─────────────────────────────────────────────────────────────────────────────

Assumed cheat sheet for these examples:

  ── Monitor ──
  LG:
    - 34GS95QE-B  [primary]
  Samsung:
    - S32FG810SU — 32" QD-OLED, 240Hz  [primary]

── Example A — same-as (no clues) ──

Comment (replying to a parent that endorsed the LG 34GS95QE-B):
  "I have the same one, love it."

Output:
  {
    "type": "referenced",
    "brand": "LG",
    "model": "",
    "contentQuality": "low",
    "referenceModel": "34GS95QE-B"
  }

  Reasoning: the user claims to own exactly the cheat-sheet product. Brand
  "LG" copied from the section header; model "34GS95QE-B" copied verbatim
  from the cheat-sheet line. No model code from the user, no distinguishing
  trait, no spec → bare same-as anchor. No modelClues or variantClues. type
  is "referenced" — the comment adds no new identification info beyond the
  cheat-sheet anchor.

── Example B — variant with explicit model code (Samsung G8sd) ──

Comment (replying to a parent referencing Samsung S32FG810SU):
  "There's a newer version of this model with full size ports. G8sd I think
  it's called, it has a black remote. The panel is great, if it had android
  instead of tizen os it would have been awesome."

Output:
  {
    "type": "explicit",
    "brand": "Samsung",
    "model": "",
    "contentQuality": "high",
    "referenceModel": "S32FG810SU",
    "modelClues": ["G8sd"],
    "variantClues": ["full-size ports", "black remote", "Tizen OS", "newer version"]
  }

  Reasoning: the user references the cheat-sheet S32FG810SU and describes a
  different SKU within the same family. model is left empty — "G8sd" goes in
  modelClues, not model, because we don't know it is a real catalog SKU.
  "full-size ports", "black remote", "Tizen OS", "newer version" don't fit any
  structured spec name → all in variantClues.

── Example C — variant with structured spec, no model code (39" LG) ──

Comment (replying to a parent that endorsed the LG 34GS95QE-B):
  "I'm currently testing the 39\\" LG OLED, the 800R is good in most games
  but for the love of god, it seems awful for any kind of 2D platformers."

Output:
  {
    "type": "explicit",
    "brand": "LG",
    "model": "",
    "contentQuality": "high",
    "specs": [
      { "name": "screenSize", "value": "39\\"" },
      { "name": "panelType", "value": "OLED" },
      { "name": "curvature", "value": "800R" }
    ],
    "referenceModel": "34GS95QE-B"
  }

  Reasoning: the user explicitly says 39", which is a structured screenSize
  spec → goes in specs, not variantClues. panelType and curvature are also
  structured. No model code mentioned → model empty, modelClues empty,
  variantClues empty. The user is talking about a sibling SKU of 34GS95QE-B
  → referenceModel: "34GS95QE-B". Do NOT copy "34GS95QE-B" from the OP into
  model — that would be guessing the SKU.

── Example D — unrelated new product (no anchor) ──

Comment: "Have you considered the Gigabyte M28U? It's cheaper and 144Hz."

Output:
  {
    "type": "explicit",
    "brand": "Gigabyte",
    "model": "M28U",
    "categoryHint": "monitor",
    "contentQuality": "medium",
    "specs": [{ "name": "refreshRate", "value": "144Hz" }]
  }

  Reasoning: the M28U is not in the cheat sheet and is a fundamentally
  different product line. No referenceModel, no modelClues, no variantClues.
  Goes through the standard unanchored resolution path.

─────────────────────────────────────────────────────────────────────────────
STEP 5 — REFERENCE TYPE: EXPLICIT vs REFERENCED
─────────────────────────────────────────────────────────────────────────────

For every product you emit, set type to either "explicit" or "referenced":

  referenced — the comment refers back to a product mentioned earlier in this
    conversation WITHOUT adding new identification info (no specs, no version,
    no model number, no disambiguating descriptor). Use this when the
    comment's product reference is a bare callback ("I love mine", "same as
    yours", "it broke after a year") or a brand-only mention that points at a
    product already established in the cheat sheet.

  explicit — the comment introduces a new product OR provides identification
    info that may clarify which version is meant. Use this when:
      - the comment names a new brand/model not yet in the cheat sheet, OR
      - the comment provides a specific model number, generation marker, or
        version label, OR
      - the comment provides specs, size, panel type, or other structured
        traits that pin down which variant is meant, OR
      - the comment uses a disambiguating descriptor ("the Pro version",
        "the smaller one", "the newer model").

When in doubt, prefer "explicit". A "referenced" type tells the system to
treat the mention as a bare back-reference and inherit the parent's
resolution; "explicit" lets the resolver run on the commenter's information.

── linkId — same-product group ───────────────────────────────────────────────

Put a \`linkId\` letter on EVERY product. Give all mentions of the SAME EXACT
product the same letter — across every comment in this response, including bare
back-references ("the LG", "that monitor") and a product named explicitly in
one comment and referenced in another. Use a NEW letter (A, then B, then C, …)
for each distinct product, and a NEW letter for a sibling/variant SKU (a
different model is a different product). This lets the pipeline resolve each
product once and share the result across all its mentions.

${identificationExamples}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildIdentificationSystemPrompt(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  const body = buildIdentificationPromptBody(categoryConfigs);
  const scope = buildIdentificationScopeSection(categoryConfigs);
  return `${body}

${scope}`;
}
