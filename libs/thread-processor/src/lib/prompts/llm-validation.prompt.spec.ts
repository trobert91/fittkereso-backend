import { ValidationCases } from "@ebike-backend/database";
import { ThreadCategoryConfig } from "../models/thread-context";
import { buildValidationSystemPrompt } from "./llm-validation.prompt";

function makeCategoryConfig(
  partial: Partial<ThreadCategoryConfig> = {},
): ThreadCategoryConfig {
  return {
    categoryId: "cat-id",
    categoryName: "Test Category",
    confidence: 1,
    promptConfig: {},
    useCases: [],
    features: [],
    issues: [],
    ...partial,
  };
}

describe("buildValidationSystemPrompt", () => {
  it("renders the static decision table and stay-silent footer regardless of category", () => {
    const prompt = buildValidationSystemPrompt({ categoryConfigs: [] });

    expect(prompt).toContain("DECISION TABLE — the 9 emittable issue types");
    expect(prompt).toContain("| 1 | wrong_sentiment |");
    expect(prompt).toContain("| 2 | wrong_experience |");
    expect(prompt).toContain("| 9 | speculative_flag_mismatch |");
    expect(prompt).toContain("WHEN TO STAY SILENT");
    expect(prompt).toContain("Silence is approval.");
  });

  it("renders the static enum vocabularies regardless of category", () => {
    const prompt = buildValidationSystemPrompt({ categoryConfigs: [] });

    expect(prompt).toContain("experience:");
    expect(prompt).toContain("  - owner:");
    expect(prompt).toContain("depth:");
    expect(prompt).toContain("  - comprehensive:");
    expect(prompt).toContain("intents (set, max 2):");
    expect(prompt).toContain("  - recommendation:");
    expect(prompt).toContain("sentiment:");
    expect(prompt).toContain("  - mixed:");
  });

  it("renders the WORKED CASES catalogue with the neutral fallback when no categoryConfigs are provided", () => {
    const prompt = buildValidationSystemPrompt({ categoryConfigs: [] });

    expect(prompt).toContain("WORKED CASES (catalogue)");
    expect(prompt).toContain("```json");
    // Neutral fallback uses Product A / Product B placeholders.
    expect(prompt).toContain("Product A");
  });

  it("uses category-supplied validationCases when present", () => {
    const monitorCases: ValidationCases = [
      {
        note: "Monitor-specific case for testing.",
        input:
          '[VALIDATE] @user: "MONITOR-CASE-INPUT"\n  Ref A (Test Monitor): sentiment: negative',
        expected: { refs: [] },
      },
    ];
    const monitors = makeCategoryConfig({
      categoryId: "monitors",
      promptConfig: { validationCases: monitorCases },
    });

    const prompt = buildValidationSystemPrompt({ categoryConfigs: [monitors] });

    expect(prompt).toContain("MONITOR-CASE-INPUT");
    expect(prompt).toContain("Monitor-specific case for testing.");
    // Fallback content should NOT leak through when a category provides cases.
    expect(prompt).not.toContain("Product A");
  });

  it("picks cases from the highest-priority category when multiple match", () => {
    const primary = makeCategoryConfig({
      categoryId: "primary",
      promptConfig: {
        validationCases: [
          {
            note: "Primary case.",
            input: "PRIMARY-CASE",
            expected: { refs: [] },
          },
        ],
      },
    });
    const secondary = makeCategoryConfig({
      categoryId: "secondary",
      promptConfig: {
        validationCases: [
          {
            note: "Secondary case.",
            input: "SECONDARY-CASE",
            expected: { refs: [] },
          },
        ],
      },
    });

    const prompt = buildValidationSystemPrompt({
      categoryConfigs: [primary, secondary],
    });

    expect(prompt).toContain("PRIMARY-CASE");
    expect(prompt).not.toContain("SECONDARY-CASE");
  });

  it("falls through to the next category when the highest-priority one has an empty validationCases array", () => {
    const empty = makeCategoryConfig({
      categoryId: "empty",
      promptConfig: { validationCases: [] },
    });
    const populated = makeCategoryConfig({
      categoryId: "populated",
      promptConfig: {
        validationCases: [
          {
            note: "Populated case.",
            input: "POPULATED-CASE",
            expected: { refs: [] },
          },
        ],
      },
    });

    const prompt = buildValidationSystemPrompt({
      categoryConfigs: [empty, populated],
    });

    expect(prompt).toContain("POPULATED-CASE");
  });
});
