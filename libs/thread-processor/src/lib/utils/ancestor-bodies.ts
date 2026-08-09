import type { UserComment } from "@ebike-backend/database";
import type { ThreadContext } from "../models/thread-context";

export interface AncestorBodies {
  parentCommentBody?: string;
  grandparentCommentBody?: string;
}

/**
 * Build the parent + grandparent comment bodies for the resolution LLM's
 * `ResolutionThreadContext`. Stops the walk at the OP since OP's content is
 * already surfaced separately via `opSummary` — including the OP body in the
 * ancestor stack would just duplicate that section.
 *
 * Skip conditions:
 *  - Current comment IS the OP (`externalId === 'OP'`) — no ancestor fields
 *    (OP context flows via `opSummary`).
 *  - Parent is the OP — skip both fields (use `opSummary`).
 *  - Grandparent is the OP — include parent body, skip grandparent.
 *  - Missing parent or grandparent — omit the missing level and any above.
 *
 * Ancestor lookup pattern:
 *  - When a `ThreadContext` is supplied, walks via
 *    `parent.externalId → context.getByExternalId(...)` (the standard
 *    in-memory pattern used by `resolution-input-enricher` and `tree.ts`).
 *  - Falls back to direct `comment.parent` / `comment.parent.parent` field
 *    traversal when no context is supplied (e.g. deferred-retry callsite
 *    that doesn't hold a `ThreadContext`). In that case the parent relations
 *    must already be hydrated by the repository query — otherwise the helper
 *    returns empty.
 */
export function buildAncestorBodies(
  comment: UserComment,
  context?: ThreadContext,
): AncestorBodies {
  // Current comment is the OP — opSummary covers it; no ancestor fields add signal.
  if (comment.externalId === "OP") return {};

  const parent = resolveParent(comment, context);
  if (!parent) return {};
  // Parent is the OP — opSummary already covers it.
  if (parent.externalId === "OP") return {};

  const grandparent = resolveParent(parent, context);
  // No grandparent at all, or grandparent is the OP — keep only parent.
  if (!grandparent || grandparent.externalId === "OP") {
    return { parentCommentBody: parent.body ?? undefined };
  }

  return {
    parentCommentBody: parent.body ?? undefined,
    grandparentCommentBody: grandparent.body ?? undefined,
  };
}

/** Lookup the immediate parent of `comment`. Prefers the in-memory
 *  `ThreadContext` map when supplied; falls back to the TypeORM-hydrated
 *  `.parent` relation. Returns undefined when neither path yields a comment. */
function resolveParent(
  comment: UserComment,
  context: ThreadContext | undefined,
): UserComment | undefined {
  const parentExternalId = comment.parent?.externalId;
  if (!parentExternalId) return undefined;
  if (context) {
    const fromContext = context.getByExternalId(parentExternalId);
    if (fromContext) return fromContext;
  }
  // Fall back to whatever the entity already has hydrated.
  return comment.parent ?? undefined;
}
