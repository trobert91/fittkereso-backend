import { Injectable } from "@nestjs/common";
import {
  ProductReferenceRepository,
  Thread,
  UserComment,
  ProductReference,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import {
  ResolutionResultApplierService,
  ResolutionService,
} from "@ebike-backend/resolution";
import { ProcessorConfigService } from "@ebike-backend/config";
import { referenceToResolutionInput } from "./reference-to-resolution-input";
import { buildAncestorBodies } from "../utils/ancestor-bodies";

@Injectable()
export class ProductReferenceResolutionService {
  private readonly logger = new CustomLogger(
    ProductReferenceResolutionService.name,
  );

  constructor(
    private readonly referenceRepo: ProductReferenceRepository,
    private readonly productSearch: ResolutionService,
    private readonly resolutionApplier: ResolutionResultApplierService,
    private readonly processorConfig: ProcessorConfigService,
  ) {}

  public async resolve(
    thread: Thread,
    comment: UserComment,
    reference: ProductReference,
    options?: { forceWebSearch?: boolean },
  ): Promise<boolean> {
    if (reference.resolutionFinished) {
      return true;
    }

    try {
      const result = await this.productSearch.search(
        referenceToResolutionInput(reference),
        {
          webSearchEnabled:
            options?.forceWebSearch ||
            comment.externalId === "OP" ||
            (reference.enabled &&
              reference.relevance >=
                this.processorConfig.webSearchRelevanceGate &&
              (reference?.quotes ?? []).length > 1),
          useEmbedding: true,
          mode: "loose",
        },
        {
          threadId: thread.id,
          threadContext: {
            threadTitle: thread.title,
            subreddit: thread.topic,
            opSummary: thread.opSummary ?? undefined,
            commentBody: comment.body ?? undefined,
            // Walk via TypeORM-hydrated `.parent` relations (no ThreadContext
            // available in this code path). Yields ancestor bodies only when
            // the caller's query loaded `relations: ['parent', 'parent.parent']`.
            ...buildAncestorBodies(comment),
          },
        },
        undefined,
        {
          threadId: thread.id,
          commentId: comment.id,
          productReferenceId: reference.id,
        },
      );

      reference.searchContext = result.context;
      await this.resolutionApplier.apply(reference, result, {
        commentBody: comment.body ?? "",
      });
      return true;
    } catch (error: unknown) {
      this.logger.error(
        `Error resolving product ${reference.context?.identification?.displayName}`,
        error,
        {
          input: reference.context.identification,
          threadId: thread.id,
          commentId: comment.id,
          productReferenceId: reference.id,
        },
      );

      throw error;
    } finally {
      await this.referenceRepo.save(reference);
    }
  }
}
