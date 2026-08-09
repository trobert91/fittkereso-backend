import {
  ProductReference,
  Sentiment,
  UserComment,
} from "@ebike-backend/database";
import { IdentificationQualityDetector } from "./identification-quality.detector";
import { DetectionContext } from "../../../interfaces/issue-detector.interface";

function makeRef(
  model: string | undefined,
  brand?: string,
  quoteTexts: string[] = [],
): ProductReference {
  const ref = new ProductReference();
  ref.context = {
    identification: { brand, model },
    resolution: {},
  } as ProductReference["context"];
  ref.quotes = quoteTexts.map((text, i) => ({
    id: `q${i}`,
    text,
    sentiment: Sentiment.Neutral,
  }));
  return ref;
}

function makeCtx(commentBody: string): DetectionContext {
  const comment = new UserComment();
  comment.body = commentBody;
  return {
    commentBody,
    comment,
    issueLabelsIndex: new Map(),
  };
}

describe("IdentificationQualityDetector", () => {
  const detector = new IdentificationQualityDetector();

  describe("cheat_sheet_collapse_with_contrast_cue", () => {
    it("fires when ref's quotes contain a contrast cue and emitted model is not in them", () => {
      const ref = makeRef("Odyssey OLED G8", "Samsung", [
        "There is a newer version of this model with full size ports.",
      ]);
      const ctx = makeCtx(
        "There is a newer version of this model with full size ports.",
      );
      const issues = detector
        .detect(ref, ctx)
        .filter((i) => i.type === "cheat_sheet_collapse_with_contrast_cue");
      expect(issues).toHaveLength(1);
    });

    it("does NOT fire when emitted model appears in the ref's quotes", () => {
      const ref = makeRef("Odyssey OLED G8", "Samsung", [
        "the Odyssey OLED G8 is the older version.",
      ]);
      const ctx = makeCtx("the Odyssey OLED G8 is the older version.");
      const issues = detector
        .detect(ref, ctx)
        .filter((i) => i.type === "cheat_sheet_collapse_with_contrast_cue");
      expect(issues).toHaveLength(0);
    });

    it("does NOT fire when there is no contrast cue in the ref's quotes", () => {
      const ref = makeRef("Odyssey OLED G8", "Samsung", [
        "I love this monitor.",
      ]);
      const ctx = makeCtx("I love this monitor.");
      const issues = detector
        .detect(ref, ctx)
        .filter((i) => i.type === "cheat_sheet_collapse_with_contrast_cue");
      expect(issues).toHaveLength(0);
    });

    it("does NOT fire when contrast cue lives in the comment body but not in this ref's quotes", () => {
      const ref = makeRef("Odyssey OLED G8", "Samsung", [
        "the Odyssey OLED G8 is great.",
      ]);
      const ctx = makeCtx(
        "There is a newer version of this model. Also, the Odyssey OLED G8 is great.",
      );
      const issues = detector
        .detect(ref, ctx)
        .filter((i) => i.type === "cheat_sheet_collapse_with_contrast_cue");
      expect(issues).toHaveLength(0);
    });
  });

  it("clean ref produces no issues", () => {
    const ref = makeRef("Odyssey OLED G8 S34DG850SU", "Samsung", [
      "the Samsung Odyssey OLED G8 S34DG850SU is great.",
    ]);
    const ctx = makeCtx("the Samsung Odyssey OLED G8 S34DG850SU is great.");
    expect(detector.detect(ref, ctx)).toHaveLength(0);
  });
});
