import {
  ProductReference,
  StructuredSpec,
  UserComment,
} from "@ebike-backend/database";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { ThreadContext } from "../models/thread-context";
import { SubtreeNode } from "../models/subtree.model";
import {
  buildAncestryIndex,
  detectSubjectSwitch,
  isSameProduct,
  ResolutionInputEnricher,
} from "./resolution-input-enricher.service";

function makeDynamicConfigStub(
  overrides?: Partial<{ subjectSwitchClassifierEnabled: boolean }>,
): DynamicConfigService {
  return {
    enrichment: {
      subjectSwitchClassifierEnabled:
        overrides?.subjectSwitchClassifierEnabled ?? true,
    },
  } as unknown as DynamicConfigService;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeComment(
  externalId: string,
  options: {
    authorId?: string;
    parent?: UserComment;
    refs?: Array<{
      brand?: string;
      model?: string;
      specs?: StructuredSpec[];
      enabled?: boolean;
    }>;
  } = {},
): UserComment {
  const comment = new UserComment();
  comment.externalId = externalId;
  comment.authorId = options.authorId;
  comment.parent = options.parent;
  comment.productReferences = (options.refs ?? []).map((ref) => {
    const reference = new ProductReference();
    reference.enabled = ref.enabled ?? true;
    reference.context = {
      identification: {
        brand: ref.brand,
        model: ref.model,
        specs: ref.specs ?? [],
      },
      resolution: {},
    } as ProductReference["context"];
    return reference;
  });
  return comment;
}

function makePlanNode(comment: UserComment, depth = 0): SubtreeNode {
  return { comment, nodeType: "PLAN", depth };
}

function makeContextWithComments(comments: UserComment[]): ThreadContext {
  const context = new ThreadContext();
  for (const comment of comments) {
    context.addComment(comment);
  }
  return context;
}

// ─── isSameProduct ───────────────────────────────────────────────────────────

describe("isSameProduct", () => {
  it("returns true for exact normalized match", () => {
    expect(isSameProduct(undefined, "341CQP", undefined, "341CQP")).toBe(true);
  });

  it("returns true when shorter model is contained within longer (letter-digit boundary)", () => {
    // "MAG341CQP" contains "341CQP" with letter→digit boundary before "3"
    expect(isSameProduct(undefined, "341CQP", undefined, "MAG341CQP")).toBe(
      true,
    );
  });

  it("returns true when space-separated prefix is normalized away", () => {
    // "MAG 341CQP" → normalized to "MAG341CQP"
    expect(isSameProduct(undefined, "341CQP", undefined, "MAG 341CQP")).toBe(
      true,
    );
  });

  it("returns true for hyphen boundary", () => {
    // "341CQP-DE" contains "341CQP" with hyphen after
    expect(isSameProduct(undefined, "341CQP", undefined, "341CQP-DE")).toBe(
      true,
    );
  });

  it("returns false when same-type characters continue after match (no boundary)", () => {
    // "341CQPX" — "X" follows "P" (both letters), no boundary
    expect(isSameProduct(undefined, "341CQP", undefined, "341CQPX")).toBe(
      false,
    );
  });

  it("returns false when no containment", () => {
    expect(isSameProduct(undefined, "MPG341CQP", undefined, "MAG341CQP")).toBe(
      false,
    );
  });

  it("returns false for completely different models", () => {
    expect(isSameProduct(undefined, "341CQP", undefined, "AW3423DWF")).toBe(
      false,
    );
  });

  it("returns false when brands differ (both present)", () => {
    expect(isSameProduct("MSI", "341CQP", "LG", "341CQP")).toBe(false);
  });

  it("returns true when one brand is missing (no contradiction)", () => {
    expect(isSameProduct("MSI", "341CQP", undefined, "341CQP")).toBe(true);
    expect(isSameProduct(undefined, "341CQP", "MSI", "341CQP")).toBe(true);
  });

  it("returns false when either model is missing", () => {
    expect(isSameProduct("MSI", undefined, "MSI", "341CQP")).toBe(false);
    expect(isSameProduct("MSI", "341CQP", "MSI", undefined)).toBe(false);
  });
});

// ─── buildAncestryIndex ───────────────────────────────────────────────────────

describe("buildAncestryIndex", () => {
  it("returns empty maps for a single root node", () => {
    const root = makeComment("root");
    const context = makeContextWithComments([root]);
    const index = buildAncestryIndex([makePlanNode(root)], context);

    expect(index.ancestors.get("root")).toEqual(new Set());
    expect(index.descendants.size).toBe(0);
  });

  it("builds correct ancestor/descendant maps for a chain", () => {
    const grandparent = makeComment("gp");
    const parent = makeComment("p", { parent: grandparent });
    const child = makeComment("c", { parent: parent });

    const context = makeContextWithComments([grandparent, parent, child]);
    const index = buildAncestryIndex(
      [
        makePlanNode(grandparent),
        makePlanNode(parent, 1),
        makePlanNode(child, 2),
      ],
      context,
    );

    // Child's ancestors: parent and grandparent
    expect(index.ancestors.get("c")).toEqual(new Set(["p", "gp"]));

    // Grandparent's descendants: both parent and child
    expect(index.descendants.get("gp")).toEqual(new Set(["p", "c"]));

    // Parent's descendants: only child
    expect(index.descendants.get("p")).toEqual(new Set(["c"]));
  });

  it("handles sibling nodes (no shared ancestry beyond common ancestor)", () => {
    const root = makeComment("root");
    const sibA = makeComment("a", { parent: root });
    const sibB = makeComment("b", { parent: root });

    const context = makeContextWithComments([root, sibA, sibB]);
    const index = buildAncestryIndex(
      [makePlanNode(root), makePlanNode(sibA, 1), makePlanNode(sibB, 1)],
      context,
    );

    // Root is ancestor of both siblings
    expect(index.descendants.get("root")).toEqual(new Set(["a", "b"]));
    // Siblings are not ancestors of each other
    expect(index.ancestors.get("a")).toEqual(new Set(["root"]));
    expect(index.ancestors.get("b")).toEqual(new Set(["root"]));
  });
});

// ─── ResolutionInputEnricher ──────────────────────────────────────────────────

describe("ResolutionInputEnricher", () => {
  let enricher: ResolutionInputEnricher;

  beforeEach(() => {
    enricher = new ResolutionInputEnricher(makeDynamicConfigStub());
  });

  function makeReference(
    brand: string | undefined,
    model: string,
    specs: StructuredSpec[] = [],
  ): ProductReference {
    const reference = new ProductReference();
    reference.enabled = true;
    reference.context = {
      identification: { brand, model, specs },
      resolution: {},
    } as ProductReference["context"];
    return reference;
  }

  it("returns input with no spec enrichment when no descendants, ancestors, or affinity entries match", () => {
    const comment = makeComment("c1", { authorId: "user1" });
    const reference = makeReference("MSI", "341CQP");
    const context = makeContextWithComments([comment]);
    const index = buildAncestryIndex([makePlanNode(comment)], context);

    const result = enricher.enrichInput(
      reference,
      comment,
      index,
      [makePlanNode(comment)],
      context,
    );

    expect(result.brand).toBe("MSI");
    expect(result.model).toBe("341CQP");
    expect(result.specs).toEqual([]);
  });

  it("merges specs from a descendant with the same product", () => {
    const parent = makeComment("p1");
    const child = makeComment("c1", {
      parent: parent,
      refs: [
        {
          brand: "MSI",
          model: "341CQP",
          specs: [
            { name: "refreshRate", value: "175Hz" },
            { name: "panelType", value: "QD-OLED" },
          ],
        },
      ],
    });

    const context = makeContextWithComments([parent, child]);
    const planNodes = [makePlanNode(parent, 0), makePlanNode(child, 1)];
    const index = buildAncestryIndex(planNodes, context);

    const reference = makeReference("MSI", "341CQP");
    const result = enricher.enrichInput(
      reference,
      parent,
      index,
      planNodes,
      context,
    );

    expect(result.specs).toEqual([
      { name: "refreshRate", value: "175Hz" },
      { name: "panelType", value: "QD-OLED" },
    ]);
  });

  it("merges own specs with descendant specs, deduplicating by name", () => {
    const parent = makeComment("p1");
    const child = makeComment("c1", {
      parent: parent,
      refs: [
        {
          brand: "MSI",
          model: "341CQP",
          specs: [
            { name: "refreshRate", value: "175Hz" },
            { name: "panelType", value: "QD-OLED" },
          ],
        },
      ],
    });

    const context = makeContextWithComments([parent, child]);
    const planNodes = [makePlanNode(parent, 0), makePlanNode(child, 1)];
    const index = buildAncestryIndex(planNodes, context);

    // Reference already has refreshRate; descendant adds panelType (new)
    const reference = makeReference("MSI", "341CQP", [
      { name: "refreshRate", value: "175Hz" },
    ]);
    const result = enricher.enrichInput(
      reference,
      parent,
      index,
      planNodes,
      context,
    );

    expect(result.specs).toEqual([
      { name: "refreshRate", value: "175Hz" },
      { name: "panelType", value: "QD-OLED" },
    ]);
  });

  it("ignores descendant refs with a different product", () => {
    const parent = makeComment("p1");
    const child = makeComment("c1", {
      parent: parent,
      refs: [
        {
          brand: "LG",
          model: "C3",
          specs: [
            { name: "panelType", value: "OLED" },
            { name: "refreshRate", value: "120Hz" },
          ],
        },
      ],
    });

    const context = makeContextWithComments([parent, child]);
    const planNodes = [makePlanNode(parent, 0), makePlanNode(child, 1)];
    const index = buildAncestryIndex(planNodes, context);

    const reference = makeReference("MSI", "341CQP");
    const result = enricher.enrichInput(
      reference,
      parent,
      index,
      planNodes,
      context,
    );

    // Descendant ref is a different product — no spec enrichment happens.
    expect(result.specs).toEqual([]);
  });

  it("ignores disabled descendant refs", () => {
    const parent = makeComment("p1");
    const child = makeComment("c1", {
      parent: parent,
      refs: [
        {
          brand: "MSI",
          model: "341CQP",
          specs: [{ name: "refreshRate", value: "175Hz" }],
          enabled: false,
        },
      ],
    });

    const context = makeContextWithComments([parent, child]);
    const planNodes = [makePlanNode(parent, 0), makePlanNode(child, 1)];
    const index = buildAncestryIndex(planNodes, context);

    const reference = makeReference("MSI", "341CQP");
    const result = enricher.enrichInput(
      reference,
      parent,
      index,
      planNodes,
      context,
    );

    // Disabled descendant ref — no enrichment.
    expect(result.specs).toEqual([]);
  });

  it("merges specs from an ancestor comment with the same product", () => {
    const grandparent = makeComment("gp", {
      refs: [
        {
          brand: "MSI",
          model: "341CQP",
          specs: [{ name: "screenSize", value: "34 inch" }],
        },
      ],
    });
    const parent = makeComment("p1", { parent: grandparent });
    const child = makeComment("c1", { parent: parent });

    const context = makeContextWithComments([grandparent, parent, child]);
    const planNodes = [makePlanNode(child, 2)];
    const index = buildAncestryIndex(planNodes, context);

    const reference = makeReference("MSI", "341CQP");
    const result = enricher.enrichInput(
      reference,
      child,
      index,
      planNodes,
      context,
    );

    expect(result.specs).toEqual([{ name: "screenSize", value: "34 inch" }]);
  });

  it("merges specs from author affinity for the same product", () => {
    const comment = makeComment("c1", { authorId: "user1" });
    const reference = makeReference("MSI", "341CQP");

    const context = makeContextWithComments([comment]);
    context.authorProductAffinity.set("user1", [
      {
        experience: "OWNER" as any,
        product: {
          brand: { name: "MSI" },
          model: "341CQP",
          orderedSpecs: [
            { key: "refreshRate", label: "Refresh Rate", value: "175 Hz" },
            { key: "panelType", label: "Panel", value: "QD-OLED" },
          ],
        } as any,
      },
    ]);

    const planNodes = [makePlanNode(comment)];
    const index = buildAncestryIndex(planNodes, context);

    const result = enricher.enrichInput(
      reference,
      comment,
      index,
      planNodes,
      context,
    );

    expect(result.specs).toEqual([
      { name: "refreshRate", value: "175 Hz" },
      { name: "panelType", value: "QD-OLED" },
    ]);
  });

  it("returns original input when no new specs are found (all duplicates)", () => {
    const parent = makeComment("p1");
    const child = makeComment("c1", {
      parent: parent,
      refs: [
        {
          brand: "MSI",
          model: "341CQP",
          specs: [{ name: "refreshRate", value: "175Hz" }],
        },
      ],
    });

    const context = makeContextWithComments([parent, child]);
    const planNodes = [makePlanNode(parent, 0), makePlanNode(child, 1)];
    const index = buildAncestryIndex(planNodes, context);

    // Reference already has the same spec the descendant would contribute —
    // dedup keeps the original spec list.
    const reference = makeReference("MSI", "341CQP", [
      { name: "refreshRate", value: "175Hz" },
    ]);
    const result = enricher.enrichInput(
      reference,
      parent,
      index,
      planNodes,
      context,
    );

    expect(result.specs).toEqual([{ name: "refreshRate", value: "175Hz" }]);
  });
});

// ─── detectSubjectSwitch ─────────────────────────────────────────────────────

describe("detectSubjectSwitch", () => {
  describe("positive cases (subject switch detected)", () => {
    it('fires on "I switched to <Brand Model>"', () => {
      expect(
        detectSubjectSwitch("I switched to the LG 27GR95B last week."),
      ).toBe(true);
    });

    it('fires on "I just switched to <Brand Model>"', () => {
      expect(detectSubjectSwitch("I just switched to a Samsung G8.")).toBe(
        true,
      );
    });

    it('fires on "I switched from <Brand Model>"', () => {
      expect(
        detectSubjectSwitch(
          "I switched from the Dell U2723QE to something better.",
        ),
      ).toBe(true);
    });

    it('fires on "instead I got <Brand Model>"', () => {
      expect(detectSubjectSwitch("Instead I got the Sony A95L.")).toBe(true);
    });

    it('fires on "now I am using <Brand Model>"', () => {
      expect(
        detectSubjectSwitch("Now I am using the LG 27GR95B for daily work."),
      ).toBe(true);
    });

    it('fires on "but I have <Brand Model>"', () => {
      expect(
        detectSubjectSwitch("but I have the Sony A95L now, never going back."),
      ).toBe(true);
    });

    it('fires on "I prefer the <Brand Model>"', () => {
      expect(
        detectSubjectSwitch("I prefer the Samsung G80SD over this one."),
      ).toBe(true);
    });
  });

  describe("negative cases (NOT a subject switch)", () => {
    it('does not fire on variant statement "the 39 inch version"', () => {
      expect(
        detectSubjectSwitch(
          "There's a newer version of this model with full size ports.",
        ),
      ).toBe(false);
    });

    it('does not fire on "I have the same one"', () => {
      expect(detectSubjectSwitch("I have the same one, love it.")).toBe(false);
    });

    it('does not fire on spec preference "I prefer the OLED panel"', () => {
      expect(
        detectSubjectSwitch("I prefer the OLED panel for media work."),
      ).toBe(false);
    });

    it('does not fire on spec descriptor "I have the 39 inch version"', () => {
      expect(
        detectSubjectSwitch(
          "I'm using the 39 inch version, the curve is great.",
        ),
      ).toBe(false);
    });

    it("does not fire on bare reactions without product tokens", () => {
      expect(detectSubjectSwitch("lol nice")).toBe(false);
      expect(detectSubjectSwitch("great review")).toBe(false);
    });

    it('does not fire on "switched to using my old monitor"', () => {
      // "my old monitor" is not a brand+model token, so no switch detected.
      expect(
        detectSubjectSwitch("I switched to using my old monitor again."),
      ).toBe(false);
    });

    it("does not fire on empty input", () => {
      expect(detectSubjectSwitch("")).toBe(false);
    });
  });
});

// ─── ResolutionInputEnricher — subject switch integration ────────────────────

describe("ResolutionInputEnricher subject-switch handling", () => {
  let enricher: ResolutionInputEnricher;

  function makeReferenceWithAnchor(): ProductReference {
    const reference = new ProductReference();
    reference.enabled = true;
    reference.context = {
      identification: {
        brand: "Samsung",
        model: "",
        referenceModel: "S34DG850SU",
        modelClues: ["G8sd"],
        variantClues: [],
        specs: [],
      },
      resolution: {},
    } as ProductReference["context"];
    return reference;
  }

  it("clears referenceModel / modelClues when the comment switches subject", () => {
    enricher = new ResolutionInputEnricher(
      makeDynamicConfigStub({ subjectSwitchClassifierEnabled: true }),
    );

    const reference = makeReferenceWithAnchor();
    const comment = makeComment("c1", {
      authorId: "author-1",
      refs: [{ brand: "Samsung", model: "" }],
    });
    comment.body = "I switched to the LG 27GR95B last week — never going back.";

    const context = makeContextWithComments([comment]);
    const planNodes = [makePlanNode(comment, 0)];
    const index = buildAncestryIndex(planNodes, context);

    const result = enricher.enrichInput(
      reference,
      comment,
      index,
      planNodes,
      context,
    );

    expect(result.referenceProductId).toBeUndefined();
    expect(result.referenceModel).toBeUndefined();
    expect(result.modelClues).toBeUndefined();
    expect(result.variantClues).toBeUndefined();
  });

  it("preserves referenceModel / modelClues when no subject switch is detected", () => {
    enricher = new ResolutionInputEnricher(
      makeDynamicConfigStub({ subjectSwitchClassifierEnabled: true }),
    );

    const reference = makeReferenceWithAnchor();
    const comment = makeComment("c1", {
      authorId: "author-1",
      refs: [{ brand: "Samsung", model: "" }],
    });
    comment.body =
      "There's a newer version of this model with full size ports.";

    const context = makeContextWithComments([comment]);
    const planNodes = [makePlanNode(comment, 0)];
    const index = buildAncestryIndex(planNodes, context);

    const result = enricher.enrichInput(
      reference,
      comment,
      index,
      planNodes,
      context,
    );

    expect(result.referenceModel).toBe("S34DG850SU");
    expect(result.modelClues).toEqual(["G8sd"]);
  });

  it("does not clear when the classifier is disabled by config", () => {
    enricher = new ResolutionInputEnricher(
      makeDynamicConfigStub({ subjectSwitchClassifierEnabled: false }),
    );

    const reference = makeReferenceWithAnchor();
    const comment = makeComment("c1", {
      authorId: "author-1",
      refs: [{ brand: "Samsung", model: "" }],
    });
    // Even a clear switch should not fire when the flag is off.
    comment.body = "I switched to the LG 27GR95B.";

    const context = makeContextWithComments([comment]);
    const planNodes = [makePlanNode(comment, 0)];
    const index = buildAncestryIndex(planNodes, context);

    const result = enricher.enrichInput(
      reference,
      comment,
      index,
      planNodes,
      context,
    );

    expect(result.referenceModel).toBe("S34DG850SU");
    expect(result.modelClues).toEqual(["G8sd"]);
  });
});
