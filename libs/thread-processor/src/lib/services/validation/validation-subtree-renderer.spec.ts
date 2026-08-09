import {
  Depth,
  ExperienceType,
  ProductReference,
  Sentiment,
  UserComment,
} from "@ebike-backend/database";
import { Subtree, SubtreeNode } from "../../models/subtree.model";
import { ValidationSubtreeRenderer } from "./validation-subtree-renderer";

function makeComment(externalId: string, body: string): UserComment {
  const comment = new UserComment();
  comment.id = `id-${externalId}`;
  comment.externalId = externalId;
  comment.authorName = `user-${externalId}`;
  comment.body = body;
  return comment;
}

function makeRef(opts: {
  id: string;
  brand: string;
  model: string;
  experience?: ExperienceType;
  depth?: Depth;
  sentiment?: Sentiment;
  quotes?: ProductReference["quotes"];
}): ProductReference {
  const ref = new ProductReference();
  ref.id = opts.id;
  ref.experience = opts.experience;
  ref.depth = opts.depth;
  ref.sentiment = opts.sentiment;
  ref.quotes = opts.quotes;
  ref.context = {
    identification: {
      brand: opts.brand,
      model: opts.model,
      displayName: `${opts.brand} ${opts.model}`,
    },
    resolution: {},
  };
  return ref;
}

describe("ValidationSubtreeRenderer", () => {
  const renderer = new ValidationSubtreeRenderer();

  it("renders a quote with feature and useCase evidence, including the quote-level speculative flag", () => {
    const comment = makeComment(
      "c1",
      "I love my LG C4. The colors blow my old TV away.",
    );
    comment.productReferences = [
      makeRef({
        id: "ref-1",
        brand: "LG",
        model: "C4",
        experience: ExperienceType.Owner,
        depth: Depth.Detailed,
        sentiment: Sentiment.Positive,
        quotes: [
          {
            id: "q1",
            text: "the colors blow my old TV away",
            sentiment: Sentiment.Positive,
            speculative: false,
            features: [{ label: "colors", sentiment: Sentiment.Positive }],
            useCases: [{ label: "pc gaming" }],
          },
        ],
      }),
    ];

    const node: SubtreeNode = { comment, nodeType: "PLAN", depth: 0 };
    const subtree: Subtree = {
      id: "st-1",
      isOpSubtree: false,
      nodes: [node],
      planNodes: [node],
    };

    const { rendered, labelToRefId } = renderer.render(subtree);

    expect(labelToRefId.get("A")).toBe("ref-1");
    expect(rendered).toContain(
      '[VALIDATE] @user-c1: "I love my LG C4. The colors blow my old TV away."',
    );
    expect(rendered).toContain("Ref A (LG C4):");
    expect(rendered).toContain("experience: owner");
    expect(rendered).toContain("depth: detailed");
    expect(rendered).toContain("sentiment: positive");
    expect(rendered).toContain(
      '[q1] "the colors blow my old TV away" sentiment=positive speculative=false',
    );
    expect(rendered).toContain("features: [0] colors/positive");
    expect(rendered).toContain("useCases: [0] pc gaming/inherit");
    expect(rendered).not.toMatch(/colors\/positive \(speculative=/);
    expect(rendered).not.toMatch(/pc gaming\/inherit \(speculative=/);
  });

  it("renders speculative=true on the quote header when set", () => {
    const comment = makeComment("c1", "I'm worried about burn-in.");
    comment.productReferences = [
      makeRef({
        id: "ref-1",
        brand: "LG",
        model: "C4",
        experience: ExperienceType.Owner,
        sentiment: Sentiment.Negative,
        quotes: [
          {
            id: "q1",
            text: "I'm worried about burn-in",
            sentiment: Sentiment.Negative,
            speculative: true,
            features: [{ label: "burn-in", sentiment: Sentiment.Negative }],
          },
        ],
      }),
    ];

    const node: SubtreeNode = { comment, nodeType: "PLAN", depth: 0 };
    const subtree: Subtree = {
      id: "st-1",
      isOpSubtree: false,
      nodes: [node],
      planNodes: [node],
    };

    const { rendered } = renderer.render(subtree);
    expect(rendered).toContain("sentiment=negative speculative=true");
  });

  it("omits the evidence block for quotes that have no features or useCases", () => {
    const comment = makeComment("c1", "I ordered it.");
    comment.productReferences = [
      makeRef({
        id: "ref-1",
        brand: "Sony",
        model: "A95L",
        experience: ExperienceType.ProspectiveBuyer,
        sentiment: Sentiment.Neutral,
        quotes: [
          { id: "q1", text: "I ordered it", sentiment: Sentiment.Neutral },
        ],
      }),
    ];

    const node: SubtreeNode = { comment, nodeType: "PLAN", depth: 0 };
    const subtree: Subtree = {
      id: "st-1",
      isOpSubtree: false,
      nodes: [node],
      planNodes: [node],
    };

    const { rendered } = renderer.render(subtree);

    expect(rendered).toContain(
      '[q1] "I ordered it" sentiment=neutral speculative=false',
    );
    expect(rendered).not.toContain("features:");
    expect(rendered).not.toContain("useCases:");
  });
});
