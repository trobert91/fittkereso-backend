import {
  UserComment,
  CategoryPromptConfig,
  FeatureLabelConfig,
  IssueConfig,
  UseCaseConfig,
} from "@ebike-backend/database";
import {
  AuthorAffinityEntry,
  ProductRegistryEntry,
} from "./product-registry.model";

export interface ThreadCategoryConfig {
  categoryId: string;
  categoryName: string;
  confidence: number;
  promptConfig: CategoryPromptConfig;
  /** Feature metadata with descriptions and optional short disambiguation hints.
   *  Empty array when the category has no features. */
  features: FeatureLabelConfig[];
  /** Use case metadata with labels, descriptions, and trigger implications. */
  useCases: UseCaseConfig[];
  /** Closed-list issue vocabulary, each declaring its parent feature.
   *  Empty when the category has no issues (or hasn't migrated to the
   *  top-level shape yet — see `getIssueLabels` for the legacy fallback). */
  issues: IssueConfig[];
}

export class ThreadContext {
  constructor(
    private mapByExternalId: Record<string, UserComment> = {},
    private mapByAuthorId: Record<string, UserComment[]> = {},
  ) {}

  // ── Category focus ───────────────────────────────────────────────────────

  /**
   * Ranked category configs for this thread, already capped to the top N by
   * rank (extraction.maxFocusCategories) by SubtreeContextBuilderService.
   * Every downstream prompt builder iterates this list directly.
   */
  categoryConfigs: ThreadCategoryConfig[] = [];

  /**
   * IDs of the categories in `categoryConfigs` (top N by rank, capped by
   * extraction.maxFocusCategories). Populated by SubtreeContextBuilderService.
   * Used during Phase 4 resolution to suppress web search for out-of-focus refs.
   */
  focusCategoryIds: Set<string> = new Set();

  // ── Batching state ─────────────────────────────────────────────────────────

  /** In-memory product registry. Key: `${brand}::${model}` (lowercase). */
  productRegistry: Map<string, ProductRegistryEntry> = new Map();

  /** Author → first-hand product experience entries (OWNER / FIRST_HAND). */
  authorProductAffinity: Map<string, AuthorAffinityEntry[]> = new Map();

  /** Rendered cheat sheet for the next subtree's extraction prompt. */
  cheatSheetString = "";

  /** Formatted OP section for prompt injection. Set during Phase 0/1. */
  opSection: string | null = null;

  /** Subreddit name (e.g. "r/ultrawidemasterrace"). Injected into prompts for context. */
  subreddit: string | null = null;

  // Unified add method for both maps
  public addComment(comment: UserComment): void {
    this.addByExternalId(comment.externalId, comment);

    if (comment.authorId) {
      this.addByAuthorId(comment.authorId, comment);
    }
  }

  // External ID mapping
  private addByExternalId(externalId: string, comment: UserComment): void {
    this.mapByExternalId[externalId] = comment;
  }

  public getByExternalId(externalId: string): UserComment | undefined {
    return this.mapByExternalId[externalId];
  }

  /** All comments currently registered in the context (resident in memory with
   *  their persisted product references). Used by the rerun pre-load to seed the
   *  registry from a prior run's resolved refs before pass 1. */
  public getAllComments(): UserComment[] {
    return Object.values(this.mapByExternalId);
  }

  // Author ID mapping
  private addByAuthorId(authorId: string, comment: UserComment): void {
    if (!this.mapByAuthorId[authorId]) {
      this.mapByAuthorId[authorId] = [];
    }
    this.mapByAuthorId[authorId].push(comment);
  }

  public getByAuthorId(authorId: string): UserComment[] {
    return this.mapByAuthorId[authorId] ?? [];
  }

  public getAuthorAffinity(
    authorId: string | undefined,
  ): AuthorAffinityEntry[] {
    if (!authorId) return [];
    return this.authorProductAffinity.get(authorId) ?? [];
  }

  public getAncestors(comment: UserComment): UserComment[] {
    if (!comment.parent) {
      return [];
    }

    const path: UserComment[] = [];
    let currentComment: UserComment | undefined = this.getByExternalId(
      comment.parent.externalId,
    );

    while (currentComment) {
      path.push(currentComment);
      currentComment = currentComment.parent?.externalId
        ? this.getByExternalId(currentComment.parent.externalId)
        : undefined;
    }

    return path;
  }
}
