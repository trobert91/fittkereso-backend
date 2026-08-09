import { Injectable } from "@nestjs/common";
import { orderBy } from "lodash";
import {
  CommentTree,
  getIssueLabels,
  ProductModel,
  ProductReference,
  Thread,
  ThreadRepository,
  UserComment,
} from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { ThreadTreeService } from "@ebike-backend/thread";
import {
  ThreadContext,
  ThreadCategoryConfig,
} from "@ebike-backend/thread-processor";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";
import { SubtreeBuilderService } from "@ebike-backend/thread-processor";
import {
  RealThreadInput,
  ResolvedSubtreeCase,
} from "../scenario/scenario.types";
import { PhaseInput, ResolvedPhaseCase } from "./input.types";

/**
 * Builds PhaseInputs from a real Thread row. Mirrors the production pipeline:
 * loads the Thread with the same relations the review-collector needs, then
 * acquires the comment tree via `ThreadTreeService.getOrCreateTree` (the same
 * call site `ThreadProcessingListenerService` uses). When the cached tree is
 * stale, this hits Reddit through the rate-limited queue and persists the
 * fetched tree back to the DB — intentional, matches prod.
 *
 * Multi-subtree behavior:
 *   - When the loader emitted an `expandAll` sentinel case, this service
 *     emits one ResolvedPhaseCase per built subtree (using the sentinel's
 *     scenario-level expectations / golden for each).
 *   - Otherwise, iterates the requested cases and looks each one up by index
 *     in the built subtree map.
 *
 * Pass `noFetch=true` to short-circuit and fail when the cached tree is missing
 * or stale (useful for CI / read-only review).
 */
@Injectable()
export class RealThreadInputService {
  private readonly logger = new CustomLogger(RealThreadInputService.name);

  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly threadTreeService: ThreadTreeService,
    private readonly subtreeBuilder: SubtreeBuilderService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  async build(
    input: RealThreadInput,
    cases: ResolvedSubtreeCase[],
    options: { noFetch: boolean },
  ): Promise<ResolvedPhaseCase[]> {
    const thread = await this.loadThread(input.threadId);

    const tree = await this.acquireTree(thread, options.noFetch);
    if (!tree || tree.rootNodes.length === 0) {
      throw new Error(
        `Thread ${input.threadId} has no comment tree (cached or fetched).`,
      );
    }

    const context = this.buildContext(thread);

    // Builder packing knobs: scenario can override any subset; missing fields
    // fall back to the benchmark defaults. Logged so reports/failure triage
    // can see exactly which packing config produced the subtree map.
    const builderOverride = input.subtreeBuilder ?? {};
    const builderOptions = {
      softBudget: builderOverride.softBudget ?? 6000,
      hardBudget: builderOverride.hardBudget ?? 10000,
      maxPlanNodes: builderOverride.maxPlanNodes ?? 15,
      maxDepth: builderOverride.maxDepth ?? 8,
    };
    this.logger.log(
      `SubtreeBuilder options: softBudget=${builderOptions.softBudget}, hardBudget=${builderOptions.hardBudget}, maxPlanNodes=${builderOptions.maxPlanNodes}, maxDepth=${builderOptions.maxDepth}, benchmarkMode=${input.mode}`,
    );
    const subtreeMap = this.subtreeBuilder.buildSubtrees(
      tree,
      context,
      builderOptions,
    );

    const all = [subtreeMap.opSubtree, ...subtreeMap.subtrees];

    // Expand the 'all' sentinel into one ResolvedSubtreeCase per built subtree.
    const expandedCases =
      cases.length === 1 && cases[0].expandAll
        ? all.map((_, idx) => this.cloneAsIndexedCase(cases[0], idx))
        : cases;

    const phaseCases: ResolvedPhaseCase[] = expandedCases.map((c) => {
      const subtree = all[c.index];
      if (!subtree) {
        throw new Error(
          `Scenario requested subtreeIndex=${c.index} but only ${all.length} subtrees exist (0=OP, 1..${all.length - 1}=content).`,
        );
      }
      const phaseInput: PhaseInput = { subtree, context, thread, extras: {} };
      return { case: c, input: phaseInput };
    });

    this.logger.log(
      `Real-thread input ready: thread=${thread.id}, ${phaseCases.length} subtree case(s) (${phaseCases.map((p) => `${p.case.label}@${p.input.subtree.id}`).join(", ")})`,
    );

    return phaseCases;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * When the loader emitted a single `expandAll` sentinel case, fan it out to
   * one case per built subtree. Each child inherits the sentinel's resolved
   * scenario-level expectations and golden (no per-subtree overrides exist
   * because the author opted into `'all'` sugar).
   */
  private cloneAsIndexedCase(
    sentinel: ResolvedSubtreeCase,
    index: number,
  ): ResolvedSubtreeCase {
    return {
      index,
      label: index === 0 ? "OP" : `subtree-${index}`,
      inputId: sentinel.inputId,
      expandAll: false,
      expectations: sentinel.expectations,
      goldenOutput: sentinel.goldenOutput,
      goldenOutputMeta: sentinel.goldenOutputMeta,
    };
  }

  private async loadThread(threadId: string): Promise<Thread> {
    const thread = await this.threadRepository.repo
      .createQueryBuilder("thread")
      .addSelect(`thread.${nameOf<Thread>("commentTree")}`)
      .leftJoinAndSelect(`thread.${nameOf<Thread>("categories")}`, "categories")
      .leftJoinAndSelect("categories.productCategory", "productCategory")
      .leftJoinAndSelect(`thread.${nameOf<Thread>("comments")}`, "comments")
      .leftJoinAndSelect(
        `comments.${nameOf<UserComment>("parent")}`,
        "commentParent",
      )
      .leftJoinAndSelect(
        `comments.${nameOf<UserComment>("productReferences")}`,
        "productReferences",
      )
      .leftJoinAndSelect(
        `productReferences.${nameOf<ProductReference>("candidates")}`,
        "candidates",
      )
      .leftJoinAndSelect(`candidates.model`, "resolvedModel")
      .leftJoinAndSelect(
        `resolvedModel.${nameOf<ProductModel>("brand")}`,
        "resolvedBrand",
      )
      .leftJoinAndSelect(
        `resolvedModel.${nameOf<ProductModel>("productCategory")}`,
        "resolvedProductCategory",
      )
      .where(`thread.${nameOf<Thread>("id")} = :id`, { id: threadId })
      .getOne();
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }
    return thread;
  }

  private async acquireTree(
    thread: Thread,
    noFetch: boolean,
  ): Promise<CommentTree | undefined> {
    if (noFetch) {
      // Read-only path: only return the cached tree, never re-fetch from Reddit.
      const cached = thread.commentTree
        ? CommentTree.fromObject(thread.commentTree)
        : undefined;
      if (!cached) {
        throw new Error(
          `--no-fetch was set but thread ${thread.id} has no cached commentTree.`,
        );
      }
      return cached;
    }
    // Production path: cached if fresh, fetch from Reddit otherwise.
    return this.threadTreeService.getOrCreateTree(thread);
  }

  private buildContext(thread: Thread): ThreadContext {
    const context = new ThreadContext();
    context.subreddit = thread.topic ?? null;
    context.categoryConfigs = this.buildCategoryConfigs(thread);
    for (const comment of thread.comments ?? []) {
      context.addComment(comment);
    }
    return context;
  }

  private buildCategoryConfigs(thread: Thread): ThreadCategoryConfig[] {
    return orderBy(thread.categories ?? [], "rank").map((junction) => {
      const config = this.categoryConfigService.getConfig(
        junction.productCategory.slug,
      );
      return {
        categoryId: junction.productCategory.id,
        categoryName: junction.productCategory.name,
        confidence: junction.confidence,
        promptConfig: config?.promptConfig ?? ({} as never),
        features: config?.features ?? [],
        useCases: config?.useCases ?? [],
        issues: getIssueLabels(config),
      };
    });
  }
}
