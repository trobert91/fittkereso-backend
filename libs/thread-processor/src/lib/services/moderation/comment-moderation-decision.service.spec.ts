import {
  CommentStatus,
  ProductReference,
  ProductReferenceCandidate,
  UserComment,
} from "@ebike-backend/database";
import { ProcessorConfigService } from "@ebike-backend/config";
import { CommentModerationDecisionService } from "./comment-moderation-decision.service";

const MODERATION = {
  highRelevanceThreshold: 50,
  openSeverityReviewThreshold: 50,
  severityCap: 200,
};

function makeService(): CommentModerationDecisionService {
  const processorConfig = {
    moderation: MODERATION,
  } as unknown as ProcessorConfigService;
  return new CommentModerationDecisionService(processorConfig);
}

let refSeq = 0;
function makeRef(
  overrides: Partial<ProductReference> & { resolved?: boolean } = {},
): ProductReference {
  const ref = new ProductReference();
  ref.id = `ref-${refSeq++}`;
  ref.enabled = overrides.enabled ?? true;
  ref.relevance = overrides.relevance ?? 80;
  // Resolved = has a primary candidate; unresolved = none.
  ref.candidates = overrides.resolved
    ? ([{ isPrimary: true }] as unknown as ProductReferenceCandidate[])
    : [];
  ref.context = overrides.context ?? { identification: {}, resolution: {} };
  return Object.assign(ref, overrides);
}

function makeComment(
  refs: ProductReference[],
  extra: Partial<UserComment> = {},
): UserComment {
  const comment = new UserComment();
  comment.relevance = 80;
  comment.productReferences = refs;
  comment.context = extra.context ?? ({} as UserComment["context"]);
  comment.moderations = extra.moderations ?? [];
  return Object.assign(comment, extra);
}

describe("CommentModerationDecisionService.decide", () => {
  const service = makeService();

  it("holds a comment IN_REVIEW when all enabled refs are unresolved", () => {
    const comment = makeComment([makeRef({ resolved: false, relevance: 80 })]);
    expect(service.decide(comment).status).toBe(CommentStatus.IN_REVIEW);
  });

  it("flips to APPROVED once the last unresolved ref is resolved", () => {
    const comment = makeComment([makeRef({ resolved: true, relevance: 80 })]);
    expect(service.decide(comment).status).toBe(CommentStatus.APPROVED);
  });

  it("stays IN_REVIEW when one of two high-relevance refs is still unresolved", () => {
    const comment = makeComment([
      makeRef({ resolved: true, relevance: 80 }),
      makeRef({ resolved: false, relevance: 80 }), // still a high-relevance blocker
    ]);
    expect(service.decide(comment).status).toBe(CommentStatus.IN_REVIEW);
  });

  it("approves when both high-relevance refs are resolved", () => {
    const comment = makeComment([
      makeRef({ resolved: true, relevance: 80 }),
      makeRef({ resolved: true, relevance: 70 }),
    ]);
    expect(service.decide(comment).status).toBe(CommentStatus.APPROVED);
  });

  it("preserves a validation-LLM in_review hold even after the product resolves", () => {
    const comment = makeComment([makeRef({ resolved: true, relevance: 80 })], {
      moderations: [
        {
          reviewedBy: "validation",
          source: "validation_llm",
          suggestedStatus: CommentStatus.IN_REVIEW,
          reviewComment: "",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(service.decide(comment).status).toBe(CommentStatus.IN_REVIEW);
  });

  it("preserves a validation-LLM deleted suggestion (resolution cannot un-delete)", () => {
    const comment = makeComment([makeRef({ resolved: true, relevance: 80 })], {
      moderations: [
        {
          reviewedBy: "validation",
          source: "validation_llm",
          suggestedStatus: CommentStatus.DELETED,
          reviewComment: "",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(service.decide(comment).status).toBe(CommentStatus.DELETED);
  });

  it("drops the unresolved-ref severity once resolved (lower openIssueSeverity)", () => {
    const unresolved = service.decide(
      makeComment([makeRef({ resolved: false, relevance: 80 })]),
    );
    const resolved = service.decide(
      makeComment([makeRef({ resolved: true, relevance: 80 })]),
    );
    expect(resolved.commentOpenIssueSeverity).toBeLessThan(
      unresolved.commentOpenIssueSeverity,
    );
  });
});
