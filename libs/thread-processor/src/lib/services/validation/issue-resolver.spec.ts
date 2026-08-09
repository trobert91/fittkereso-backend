import {
  Depth,
  ExperienceType,
  Intent,
  ProductReference,
  Sentiment,
  ValidationIssue,
} from "@ebike-backend/database";
import { IssueResolver } from "./issue-resolver";

function makeRef(overrides: Partial<ProductReference> = {}): ProductReference {
  const ref = new ProductReference();
  ref.sentiment = Sentiment.Neutral;
  ref.experience = ExperienceType.Owner;
  ref.depth = Depth.Mentioned;
  ref.intents = [Intent.ExperienceReport];
  ref.enabled = true;
  ref.flagged = false;
  ref.context = {
    identification: {},
    resolution: {},
    issues: [],
  } as ProductReference["context"];
  ref.quotes = [];
  Object.assign(ref, overrides);
  return ref;
}

describe("IssueResolver", () => {
  const resolver = new IssueResolver();

  describe("LLM tier/sentiment auto-fix", () => {
    it("mutates ref.sentiment for LLM wrong_sentiment; marks resolved", () => {
      const ref = makeRef({ sentiment: Sentiment.Positive });
      const issue: ValidationIssue = {
        type: "wrong_sentiment",
        source: "llm",
        currentValue: Sentiment.Positive,
        suggestedValue: Sentiment.Negative,
        status: "pending",
      };
      resolver.apply(ref, [issue]);
      expect(ref.sentiment).toBe(Sentiment.Negative);
      expect(issue.status).toBe("resolved");
    });

    it("mutates ref.experience for LLM wrong_experience", () => {
      const ref = makeRef({ experience: ExperienceType.ProspectiveBuyer });
      const issue: ValidationIssue = {
        type: "wrong_experience",
        source: "llm",
        currentValue: ExperienceType.ProspectiveBuyer,
        suggestedValue: ExperienceType.Owner,
        status: "pending",
      };
      resolver.apply(ref, [issue]);
      expect(ref.experience).toBe(ExperienceType.Owner);
      expect(issue.status).toBe("resolved");
    });

    it("mutates ref.depth for LLM wrong_depth", () => {
      const ref = makeRef({ depth: Depth.Superficial });
      const issue: ValidationIssue = {
        type: "wrong_depth",
        source: "llm",
        currentValue: Depth.Superficial,
        suggestedValue: Depth.Detailed,
        status: "pending",
      };
      resolver.apply(ref, [issue]);
      expect(ref.depth).toBe(Depth.Detailed);
      expect(issue.status).toBe("resolved");
    });

    it("mutates ref.intents for LLM wrong_intent", () => {
      const ref = makeRef({ intents: [Intent.ExperienceReport] });
      const issue: ValidationIssue = {
        type: "wrong_intent",
        source: "llm",
        currentValue: [Intent.ExperienceReport],
        suggestedValue: [Intent.Recommendation],
        status: "pending",
      };
      resolver.apply(ref, [issue]);
      expect(ref.intents).toEqual([Intent.Recommendation]);
      expect(issue.status).toBe("resolved");
    });
  });

  describe("speculative_flag_mismatch (LLM-only, bidirectional)", () => {
    it("flips quote.speculative to true when suggestedValue=true", () => {
      const ref = makeRef({
        quotes: [
          {
            id: "q1",
            text: "I'm worried about burn-in long term",
            sentiment: Sentiment.Negative,
            speculative: false,
            features: [{ label: "burn-in", sentiment: Sentiment.Negative }],
          },
        ],
      });
      const issue: ValidationIssue = {
        type: "speculative_flag_mismatch",
        source: "llm",
        quoteId: "q1",
        suggestedValue: true,
        status: "pending",
      };
      resolver.apply(ref, [issue]);
      expect(ref.quotes![0].speculative).toBe(true);
      expect(issue.status).toBe("resolved");
    });

    it("flips quote.speculative to false when suggestedValue=false", () => {
      const ref = makeRef({
        quotes: [
          {
            id: "q1",
            text: "text rendering is razor sharp",
            sentiment: Sentiment.Positive,
            speculative: true,
            features: [
              { label: "text clarity", sentiment: Sentiment.Positive },
            ],
          },
        ],
      });
      const issue: ValidationIssue = {
        type: "speculative_flag_mismatch",
        source: "llm",
        quoteId: "q1",
        suggestedValue: false,
        status: "pending",
      };
      resolver.apply(ref, [issue]);
      expect(ref.quotes![0].speculative).toBe(false);
      expect(issue.status).toBe("resolved");
    });

    it("marks unresolved when the target quote is missing", () => {
      const ref = makeRef({ quotes: [] });
      const issue: ValidationIssue = {
        type: "speculative_flag_mismatch",
        source: "llm",
        quoteId: "q1",
        suggestedValue: true,
        status: "pending",
      };
      resolver.apply(ref, [issue]);
      expect(issue.status).toBe("unresolved");
      expect(issue.resolutionFailedReason).toContain("q1 not present");
    });
  });
});
