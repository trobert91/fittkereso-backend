import { CategoryPromptConfig } from "@ebike-backend/database";
import { ThreadCategoryConfig } from "../models/thread-context";
import { renderValidSpec } from "./valid-specs.renderer";

// ─── Category-aware section builders ──────────────────────────────────────────

function buildProductIdSection(promptConfig: CategoryPromptConfig): string {
  const examples = promptConfig.productIdExamples;
  if (examples?.length) {
    return examples
      .map(
        (e) => `  "${e.mentioned}" → brand: "${e.brand}", model: "${e.model}"`,
      )
      .join("\n");
  }
  return `  "Brand ProductLine ModelNumber" → brand: "Brand", model: "ProductLine ModelNumber"`;
}

function buildTechDescriptorList(promptConfig: CategoryPromptConfig): string {
  const descriptors = promptConfig.technologyDescriptors;
  return descriptors?.length
    ? descriptors.join(", ")
    : "technology types, driver types, connector standards";
}

function buildDiscoveryScopeSection(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  if (categoryConfigs.length === 0) {
    return `── SCOPE ──────────────────────────────────────────────────────────────────────

Discover product references from all categories.
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

const DISCOVERY_EXAMPLE = {
  products: [
    {
      brand: "LG",
      model: "34GS95QE-B",
      contentQuality: "high",
      linkLabel: "A",
      specs: [{ name: "panelType", value: "OLED" }],
    },
    {
      brand: "Samsung",
      model: "",
      categoryHint: "monitor",
      referenceModel: "S32FG810SU",
      modelClues: ["G8sd"],
      variantClues: ["full-size ports", "newer version"],
      contentQuality: "high",
      linkLabel: "B",
    },
  ],
};

// ─── Prompt body builder ──────────────────────────────────────────────────────

function buildDiscoveryPromptBody(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  const topConfig = categoryConfigs[0]?.promptConfig ?? {};
  const productIdExamples = buildProductIdSection(topConfig);
  const techDescriptorList = buildTechDescriptorList(topConfig);

  return `You discover the DISTINCT products discussed in a batch of Reddit comments.

── INPUT ─────────────────────────────────────────────────────────────────────

- A cheat sheet of products already seen earlier in this thread, each tagged
  [primary], [secondary], or [mentioned]. These products are ALREADY KNOWN.
- The original post for context.
- A tree of comments. Both [PLAN] and [CONTEXT] nodes may mention products;
  read all of them. You do NOT map products to comments here — that is a later
  step. Your job is the DISTINCT SET of products and their pooled evidence.

── OUTPUT ──────────────────────────────────────────────────────────────────────

A list of DISTINCT products. One entry per distinct product — NOT one per
mention. Pool evidence across every mention of the same product:

  - Union the specs stated by any commenter.
  - Take the richest contentQuality seen across its mentions.
  - Capture model clues / variant clues anyone provided.

Give every distinct product a stable \`linkLabel\` letter (A, B, C, …). The same
EXACT product keeps one letter; a sibling/variant SKU (any different model
token) is a DIFFERENT product and gets a NEW letter.

── KNOWN vs NEW ────────────────────────────────────────────────────────────────

For each product, decide whether it is already in the cheat sheet:
  - ALREADY KNOWN → re-surface it by its canonical identity. Set brand/model to
    the cheat-sheet values and set \`referenceModel\` to the catalog model token
    copied verbatim from its cheat-sheet line. Do this even when the current
    batch only refers to it indirectly ("the LG", "that one").
  - GENUINELY NEW (no cheat-sheet entry) → emit it with the evidence stated. Set
    categoryHint. Do NOT invent a SKU — if no model token was stated, leave
    model "" and put any partial token in modelClues.

Only emit a known product when this batch actually mentions it. Do not list the
whole cheat sheet.

── MODEL vs CLUES ──────────────────────────────────────────────────────────────

When splitting a mention into brand + model:
${productIdExamples}

brand: manufacturer name only. Tech terms alone (${techDescriptorList}) are not
products — only emit when attached to a brand or model.

  model: a model-name token the user stated and that we can treat as the SKU.
  modelClues: partial/uncertain model tokens that don't match the cheat sheet.
  variantClues: free-form traits with no structured spec equivalent.
  specs: stated values that map to a valid spec key under SCOPE.

HARD RULE: do not guess SKUs. Record observed tokens, clues, and specs.
Resolution picks the actual catalog product.

─────────────────────────────────────────────────────────────────────────────
EXAMPLE
─────────────────────────────────────────────────────────────────────────────

${JSON.stringify(DISCOVERY_EXAMPLE, null, 2)}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildProductDiscoverySystemPrompt(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  const body = buildDiscoveryPromptBody(categoryConfigs);
  const scope = buildDiscoveryScopeSection(categoryConfigs);
  return `${body}

${scope}`;
}
