import { Injectable } from "@nestjs/common";
import { CommentStatus, ProductReference } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { ThreadContext } from "../models/thread-context";
import { ProductRegistryService } from "./product-registry.service";

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Rerun pre-load. Before pass 1's loop, hydrate the in-memory registry +
 * cheat sheet from a PRIOR run's already-resolved references so discovery can
 * judge known-vs-genuinely-new. Without this, a rerun with new comments would
 * re-collect + re-resolve products a prior run already resolved (breaking
 * dedup).
 *
 * Runs ONCE up front (not per subtree) — it only seeds prior-run terminals;
 * this run's own products feed the cheat sheet incrementally as subtrees
 * process. Wires up `ProductRegistryService.loadFromReferences`, which exists
 * for exactly this but was previously never called.
 */
@Injectable()
export class RegistryPreloadService {
  private readonly logger = new CustomLogger(RegistryPreloadService.name);

  constructor(private readonly productRegistry: ProductRegistryService) {}

  preload(context: ThreadContext): void {
    const refs = this.collectPriorRunResolvedRefs(context);
    if (refs.length === 0) return;

    this.productRegistry.loadFromReferences(refs, context);
    this.logger.log("Preloaded prior-run products into registry", {
      references: refs.length,
    });
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Every reference whose comment was processed in a PRIOR run (status past
   * NEW) and that resolved to a candidate set. These are the products the
   * cheat sheet must reflect before discovery's first LLM call.
   */
  private collectPriorRunResolvedRefs(
    context: ThreadContext,
  ): ProductReference[] {
    const refs: ProductReference[] = [];
    for (const comment of context.getAllComments()) {
      if (comment.status === CommentStatus.NEW) continue;
      for (const ref of comment.productReferences ?? []) {
        if ((ref.candidates?.length ?? 0) > 0) refs.push(ref);
      }
    }
    return refs;
  }
}
