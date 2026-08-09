import type { CategoryPromptConfig } from "@ebike-backend/database";

type ValidSpec = NonNullable<CategoryPromptConfig["validSpecs"]>[number];

/**
 * Render a single validSpecs entry into the multi-line block the
 * identification and extraction prompts share.
 *
 * Each spec produces up to four indented lines so the LLM gets an explicit
 * contract instead of a single prose blob:
 *   - format: directive describing the canonical value shape (when set)
 *   - good:   comma-separated canonical examples (always rendered)
 *   - avoid:  shorthand tokens that must be translated, not extracted (when set)
 *   - note:   free-form extra guidance for cases the structured lines miss
 *
 * Separating the good vocabulary from the forbidden tokens is the main reason
 * for this rendering — burying both inside a single hint string lets the LLM
 * treat the bad tokens as illustrative rather than disallowed.
 */
export function renderValidSpec(spec: ValidSpec): string {
  const lines: string[] = [`  - ${spec.name}`];
  if (spec.format) {
    lines.push(`      format: ${spec.format}`);
  }
  lines.push(`      good:   ${spec.examples}`);
  if (spec.avoid?.length) {
    lines.push(
      `      avoid:  ${spec.avoid.join(", ")} — translate to the format above before extracting`,
    );
  }
  if (spec.hint) {
    lines.push(`      note:   ${spec.hint}`);
  }
  return lines.join("\n");
}
