import { Injectable } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import {
  UserComment,
  CommentStatus,
  ProductReference,
  ProductReferenceCandidate,
  ProductModel,
  ProductCategory,
  Brand,
  ExperienceType,
  Depth,
  Sentiment,
  Intent,
  Quote,
  Evidence,
} from "@ebike-backend/database";
import {
  Subtree,
  SubtreeNode,
  ThreadContext,
  ThreadCategoryConfig,
  NodeType,
  LLMMappedProduct,
} from "@ebike-backend/thread-processor";
import { CustomLogger } from "@ebike-backend/logger";
import { FixtureInput, ResolvedSubtreeCase } from "../scenario/scenario.types";
import { PhaseInput, PhaseInputExtras, ResolvedPhaseCase } from "./input.types";

// ─── Fixture file shape ──────────────────────────────────────────────────────

interface FixtureCommentNode {
  externalId: string;
  authorId?: string;
  authorName?: string;
  body: string;
  parentExternalId?: string;
  status?: keyof typeof CommentStatus;
  /** PLAN or CONTEXT — controls subtree.planNodes membership. */
  nodeType: NodeType;
  /** Depth in the tree (OP = 0). */
  depth: number;
}

interface FixtureSubtree {
  id: string;
  isOpSubtree: boolean;
  nodes: FixtureCommentNode[];
  /**
   * Optional per-subtree cheat sheet override. In production the cheat sheet
   * grows as products resolve subtree-by-subtree, so a single fixture-level
   * cheat sheet is only an approximation. Setting this on a subtree overrides
   * the fixture-level `cheatSheet` for that subtree only.
   */
  cheatSheet?: string;
  /**
   * Optional per-subtree OP summary override. Useful when one fixture stitches
   * subtrees from different source threads — each thread has its own OP, so a
   * single fixture-level `opSummary` doesn't fit. Setting this on a subtree
   * overrides the fixture-level `opSummary` for that subtree only.
   */
  opSummary?: string;
  /**
   * Per-PLAN-comment resolved product list, used to drive
   * `PromptAssemblyService.buildResolvedProductsSection`. Keyed by the PLAN
   * comment's `externalId`. Optional — extraction scenarios that omit this
   * will still run (the resolved-products section will simply be empty).
   *
   * `categorySlug` must match a slug under `libs/config/src/lib/categories/`
   * for spec rendering to engage; otherwise specs are dropped from the
   * rendered section because `ProductSpecContextService.getExtractionOrderedSpecs`
   * has no `primarySpecs` to order against.
   */
  resolvedProducts?: Record<string, FixtureResolvedProduct[]>;
}

/**
 * One resolved product referenced by a PLAN comment, in the shape needed to
 * synthesize an in-memory `ProductReference` whose primary candidate carries the
 * specs the extraction prompt's resolved-products section will render.
 */
interface FixtureResolvedProduct {
  brand: string;
  model: string;
  /** Optional pre-rendered display name; defaults to "<brand> <model>". */
  displayName?: string;
  /**
   * Category slug under `libs/config/src/lib/categories/`. Drives the spec
   * ordering in the resolved-products section. When omitted, specs render as
   * an empty list because `getExtractionOrderedSpecs` falls back to `[]`.
   */
  categorySlug?: string;
  /**
   * Specs the extraction prompt should see for this product. Each entry maps
   * directly to an `OrderedSpec` on the synthesized `ProductModel`. The keys
   * must appear in the category's `primarySpecs` to render.
   */
  specs?: { name: string; value: string | number | boolean }[];
  /**
   * When true, the renderer appends ` [unresolved]` to the product line and
   * suppresses the spec list. Mirrors the production case where a
   * `ProductReference` has no candidates because resolution failed or was
   * deferred — the brand/model is still in the prompt as a hint, but
   * the LLM is told there is no canonical entity yet.
   */
  unresolved?: boolean;
  /**
   * Labeling-only: experience tag the labeling user prompt renders next to
   * the product line ("experience: owner, depth: detailed, sentiment: …").
   * Maps onto `ExperienceType`. Ignored by identification/extraction.
   */
  experience?:
    | "owner"
    | "prior_owner"
    | "tested"
    | "prospective_buyer"
    | "reference";
  /** Labeling-only: depth tag rendered alongside experience. Maps onto `Depth`. */
  depth?: "comprehensive" | "detailed" | "mentioned" | "superficial";
  /** Labeling-only: per-ref sentiment summary. Maps onto `Sentiment`. */
  sentiment?: "positive" | "negative" | "neutral" | "mixed";
  /**
   * Validation-only: ref-level intent set. Each value must match one of the
   * production `Intent` enum values (recommendation, issue_report, comparison,
   * experience_report, warning, seeking_advice, question, reputation_report).
   * The validation prompt renders this on the ref header and is one of the
   * fields the LLM can flag via `wrong_intent`.
   */
  intents?: (
    | "recommendation"
    | "issue_report"
    | "comparison"
    | "experience_report"
    | "warning"
    | "seeking_advice"
    | "question"
    | "reputation_report"
  )[];
  /**
   * Labeling-only: extracted quotes attached to the synthesized
   * `ProductReference`. These are exactly the quotes the labeling LLM is
   * asked to classify with feature/use-case Evidence.
   *
   * `evidence` is validation-specific — the validation prompt renders feature
   * and useCase entries beneath each quote so the LLM can flag
   * `speculative_flag_mismatch` against a known `evidenceIndex`.
   */
  quotes?: {
    text: string;
    sentiment: Sentiment;
    speculative?: boolean;
    evidence?: {
      features?: FixtureEvidenceEntry[];
      useCases?: FixtureEvidenceEntry[];
    };
  }[];
}

interface FixtureEvidenceEntry {
  label: string;
  sentiment?: Sentiment;
}

/**
 * Identification step output for the extraction prompt's PLAN node
 * annotations. Keyed by the PLAN comment's `externalId`. Same shape as
 * `LLMMappedProduct` but accepted as plain JSON.
 */
type FixtureIdentificationResults = Record<string, LLMMappedProduct[]>;

/**
 * Extraction-only knobs that flow into `PhaseInputExtras`. Each field can be
 * overridden per-candidate via `CandidateSpec.extractionOptionsOverride`.
 */
interface FixtureExtractionOptions {
  maxFocusCategories?: number;
  maxQuotesCeiling?: number;
  validSpecNames?: string[];
  stripContext?: boolean;
}

/**
 * On-disk fixture shape. Either `subtree` (legacy single-subtree) or
 * `subtrees` (array) is required. When both are present, `subtrees` wins.
 */
interface FixtureFile {
  thread: {
    id: string;
    title?: string;
    topic?: string;
    subreddit?: string;
  };
  categoryConfigs?: ThreadCategoryConfig[];
  /**
   * OP summary that prod injects into the user prompt as `## OP:` for non-OP
   * subtrees. Lift verbatim from a logged production prompt to keep the fixture
   * byte-identical to what the pipeline sent.
   */
  opSummary?: string;
  /**
   * Cheat sheet rendered under `## Products identified in this thread:`. Same
   * provenance: lift from the logged production prompt.
   */
  cheatSheet?: string;
  subtree?: FixtureSubtree;
  subtrees?: FixtureSubtree[];
  /**
   * Identification step output, keyed by PLAN comment `externalId`. Drives
   * the `[products: ...]` annotation that
   * `PromptAssemblyService.buildCommentsSection` writes onto PLAN nodes when
   * extraction runs. Identification scenarios ignore this block.
   */
  identificationResults?: FixtureIdentificationResults;
  /**
   * Extraction knobs (`maxFocusCategories`, `maxQuotesCeiling`,
   * `validSpecNames`, `stripContext`). Each field can be overridden per
   * candidate via `CandidateSpec.extractionOptionsOverride`.
   */
  extractionOptions?: FixtureExtractionOptions;
  /**
   * Optional per-author affinity entries. In production, the resolution flow
   * registers an author as `owner` / `prior_owner` / `tested` for a product
   * once their PLAN comment yields that experience type. The renderer
   * subsequently shows `@author` for them across every subtree (and emits
   * `[owns: ...]` / `[used: ...]` annotations). Fixtures replicate that by
   * declaring affinity here, keyed by `authorId` (which fixture nodes also
   * carry). Each entry lists the products the author has affinity for; the
   * loader synthesizes minimal `ProductModel` stubs so the renderer's
   * `formatAffinityLabel` and the `getAuthorAffinity` check both succeed.
   */
  authorAffinity?: Record<string, FixtureAuthorAffinityEntry[]>;
}

interface FixtureAuthorAffinityEntry {
  /** "owner" | "prior_owner" | "tested" — anything else is rejected at load. */
  experience: "owner" | "prior_owner" | "tested";
  /** Display name shown by the rendered affinity tag (`[owns: <name>]`). */
  productDisplayName: string;
}

/**
 * Builds PhaseInputs from a hand-crafted JSON fixture. No DB, no Reddit.
 * Used for offline / CI runs where determinism and speed matter more than
 * realism.
 *
 * Multi-subtree behavior:
 *   - When the loader emitted an `expandAll` sentinel case, this service
 *     emits one ResolvedPhaseCase per subtree in the fixture file.
 *   - Otherwise, looks each requested case up by index in the fixture's
 *     `subtrees` array.
 *   - Legacy single-subtree fixtures (`subtree: {...}`) are normalized into
 *     a one-element subtrees array transparently.
 */
@Injectable()
export class FixtureInputService {
  private readonly logger = new CustomLogger(FixtureInputService.name);

  build(
    input: FixtureInput,
    cases: ResolvedSubtreeCase[],
    scenarioSourcePath: string,
  ): ResolvedPhaseCase[] {
    const fixturePath = path.resolve(
      path.dirname(scenarioSourcePath),
      input.path,
    );
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Fixture file not found: ${fixturePath}`);
    }

    const raw = fs.readFileSync(fixturePath, "utf8");
    let parsed: FixtureFile;
    try {
      parsed = JSON.parse(raw) as FixtureFile;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse fixture at ${fixturePath}: ${message}`);
    }

    // Normalize the fixture into a non-empty array of subtrees regardless of
    // whether the file uses the legacy `subtree` block or the new `subtrees` array.
    const fixtureSubtrees = this.normalizeFixtureSubtrees(parsed, fixturePath);
    this.validateShape(parsed, fixtureSubtrees, fixturePath);

    const context = this.buildContext(parsed, fixtureSubtrees);

    // Expand the 'all' sentinel into one case per subtree the fixture declares.
    const expandedCases =
      cases.length === 1 && cases[0].expandAll
        ? fixtureSubtrees.map((_, idx) =>
            this.cloneAsIndexedCase(cases[0], idx),
          )
        : cases;

    const phaseCases: ResolvedPhaseCase[] = expandedCases.map((c) => {
      const fixtureSubtree = fixtureSubtrees[c.index];
      if (!fixtureSubtree) {
        throw new Error(
          `Scenario requested fixture subtree index=${c.index} but the fixture only declares ${fixtureSubtrees.length} subtree(s).`,
        );
      }
      const subtree = this.materializeSubtree(fixtureSubtree, context);
      // Attach synthesized ProductReferences to PLAN comments when the fixture
      // supplies a resolvedProducts block. This is what
      // PromptAssemblyService.buildResolvedProductsSection walks to render the
      // per-comment product list with real specs.
      this.attachResolvedProducts(subtree, fixtureSubtree, fixturePath);
      // Per-subtree cheat-sheet / OP-summary override: in production the cheat
      // sheet grows as products resolve subtree-by-subtree, so a single
      // fixture-level value is just an approximation. The OP override is
      // useful when one fixture stitches subtrees from different source
      // threads. When either is set, build a per-case context with the
      // overrides and shared comment maps.
      const hasOverride =
        fixtureSubtree.cheatSheet !== undefined ||
        fixtureSubtree.opSummary !== undefined;
      const caseContext = hasOverride
        ? this.cloneContextWithOverrides(context, {
            cheatSheet: fixtureSubtree.cheatSheet,
            opSummary: fixtureSubtree.opSummary,
          })
        : context;
      const extras = this.buildExtras(parsed, subtree);
      return { case: c, input: { subtree, context: caseContext, extras } };
    });

    this.logger.log(
      `Fixture input ready: thread=${parsed.thread.id}, ${phaseCases.length} subtree case(s) (${phaseCases.map((p) => `${p.case.label}@${p.input.subtree.id}`).join(", ")})`,
    );

    return phaseCases;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private normalizeFixtureSubtrees(
    fixture: FixtureFile,
    fixturePath: string,
  ): FixtureSubtree[] {
    if (fixture.subtrees && fixture.subtrees.length > 0) {
      return fixture.subtrees;
    }
    if (fixture.subtree) {
      return [fixture.subtree];
    }
    throw new Error(
      `Fixture at ${fixturePath} declares neither 'subtree' nor 'subtrees' — must contain at least one subtree.`,
    );
  }

  private cloneAsIndexedCase(
    sentinel: ResolvedSubtreeCase,
    index: number,
  ): ResolvedSubtreeCase {
    return {
      index,
      label: `subtree-${index}`,
      inputId: sentinel.inputId,
      expandAll: false,
      expectations: sentinel.expectations,
      goldenOutput: sentinel.goldenOutput,
      goldenOutputMeta: sentinel.goldenOutputMeta,
    };
  }

  /**
   * Build a single ThreadContext shared across all subtrees in a fixture.
   * Iterates every comment in every subtree so cross-subtree author affinity
   * works the way it does for real threads.
   */
  private buildContext(
    fixture: FixtureFile,
    fixtureSubtrees: FixtureSubtree[],
  ): ThreadContext {
    const context = new ThreadContext();
    context.subreddit =
      fixture.thread.subreddit ?? fixture.thread.topic ?? null;
    context.categoryConfigs = fixture.categoryConfigs ?? [];
    if (fixture.opSummary) context.opSection = fixture.opSummary;
    if (fixture.cheatSheet) context.cheatSheetString = fixture.cheatSheet;

    // Materialize comments once, register by externalId so parents resolve
    // even when a parent appears in a different subtree's nodes array.
    const commentByExternalId = new Map<string, UserComment>();
    for (const fixtureSubtree of fixtureSubtrees) {
      for (const node of fixtureSubtree.nodes) {
        if (commentByExternalId.has(node.externalId)) continue;
        const comment = new UserComment();
        comment.externalId = node.externalId;
        comment.authorId = node.authorId;
        comment.authorName = node.authorName;
        comment.body = node.body;
        comment.status = node.status
          ? CommentStatus[node.status]
          : CommentStatus.NEW;
        comment.id = `fixture-${node.externalId}`;
        commentByExternalId.set(node.externalId, comment);
      }
    }
    for (const fixtureSubtree of fixtureSubtrees) {
      for (const node of fixtureSubtree.nodes) {
        const comment = commentByExternalId.get(node.externalId);
        if (!comment) continue;
        if (node.parentExternalId) {
          comment.parent = commentByExternalId.get(node.parentExternalId);
        }
      }
    }
    for (const comment of commentByExternalId.values()) {
      context.addComment(comment);
    }

    // Populate author affinity from the fixture so the prompt renderer's
    // `@author` annotations and `[owns: ...] / [used: ...]` tags engage. In
    // production this map is populated incrementally as resolution lands;
    // fixtures declare it up-front since they replay a fixed snapshot.
    if (fixture.authorAffinity) {
      this.populateAuthorAffinity(context, fixture.authorAffinity);
    }

    // Stash the comment map on the context-scoped lookup so materializeSubtree
    // can reuse it without re-registering.
    (
      context as unknown as { __fixtureCommentMap?: Map<string, UserComment> }
    ).__fixtureCommentMap = commentByExternalId;
    return context;
  }

  /**
   * Synthesize `AuthorAffinityEntry`s and write them into
   * `context.authorProductAffinity`. Each fixture entry maps to a stub
   * `ProductModel` carrying just the displayName the renderer needs;
   * resolution / scoring data is irrelevant for prompt assembly.
   */
  private populateAuthorAffinity(
    context: ThreadContext,
    affinityByAuthorId: Record<string, FixtureAuthorAffinityEntry[]>,
  ): void {
    const experienceMap: Record<
      FixtureAuthorAffinityEntry["experience"],
      ExperienceType.Owner | ExperienceType.PriorOwner | ExperienceType.Tested
    > = {
      owner: ExperienceType.Owner,
      prior_owner: ExperienceType.PriorOwner,
      tested: ExperienceType.Tested,
    };
    for (const [authorId, entries] of Object.entries(affinityByAuthorId)) {
      const list = entries.map((entry) => {
        const productModel = new ProductModel();
        productModel.displayName = entry.productDisplayName;
        productModel.normalizedName = entry.productDisplayName.toLowerCase();
        return {
          experience: experienceMap[entry.experience],
          product: productModel,
        };
      });
      context.authorProductAffinity.set(authorId, list);
    }
  }

  /**
   * Clone a ThreadContext for a single subtree case, overriding cheatSheetString
   * and/or opSection. Shares the underlying comment maps and registry — fine
   * because identification doesn't mutate them — and preserves prototype
   * methods like getByExternalId.
   */
  private cloneContextWithOverrides(
    source: ThreadContext,
    overrides: { cheatSheet?: string; opSummary?: string },
  ): ThreadContext {
    const clone = Object.create(
      Object.getPrototypeOf(source) as object,
    ) as ThreadContext;
    Object.assign(clone, source);
    if (overrides.cheatSheet !== undefined) {
      clone.cheatSheetString = overrides.cheatSheet;
    }
    if (overrides.opSummary !== undefined) {
      clone.opSection = overrides.opSummary;
    }
    return clone;
  }

  private materializeSubtree(
    fixtureSubtree: FixtureSubtree,
    context: ThreadContext,
  ): Subtree {
    const commentByExternalId = (
      context as unknown as {
        __fixtureCommentMap?: Map<string, UserComment>;
      }
    ).__fixtureCommentMap;
    if (!commentByExternalId) {
      throw new Error(
        "Internal error: fixture comment map missing from ThreadContext",
      );
    }

    const subtreeNodes: SubtreeNode[] = fixtureSubtree.nodes.map((node) => {
      const comment = commentByExternalId.get(node.externalId);
      if (!comment) {
        throw new Error(
          `Fixture inconsistency: node ${node.externalId} not found in materialized comments`,
        );
      }
      return {
        comment,
        nodeType: node.nodeType,
        depth: node.depth,
      };
    });

    return {
      id: fixtureSubtree.id,
      isOpSubtree: fixtureSubtree.isOpSubtree,
      nodes: subtreeNodes,
      planNodes: subtreeNodes.filter((n) => n.nodeType === "PLAN"),
    };
  }

  private validateShape(
    fixture: FixtureFile,
    fixtureSubtrees: FixtureSubtree[],
    fixturePath: string,
  ): void {
    const ctx = `fixture at ${fixturePath}`;
    if (!fixture.thread || !fixture.thread.id) {
      throw new Error(`${ctx}: missing thread.id`);
    }
    for (const subtree of fixtureSubtrees) {
      if (!subtree.id) throw new Error(`${ctx}: a subtree is missing 'id'`);
      if (!Array.isArray(subtree.nodes)) {
        throw new Error(
          `${ctx}: subtree ${subtree.id}: nodes must be an array`,
        );
      }
      for (const node of subtree.nodes) {
        if (!node.externalId) {
          throw new Error(
            `${ctx}: subtree ${subtree.id}: a node is missing externalId`,
          );
        }
        if (node.nodeType !== "PLAN" && node.nodeType !== "CONTEXT") {
          throw new Error(
            `${ctx}: subtree ${subtree.id}: node ${node.externalId} has invalid nodeType (must be PLAN or CONTEXT)`,
          );
        }
        if (typeof node.depth !== "number" || node.depth < 0) {
          throw new Error(
            `${ctx}: subtree ${subtree.id}: node ${node.externalId} has invalid depth`,
          );
        }
      }
    }
  }

  // ─── Extraction-specific synthesis ──────────────────────────────────────────

  /**
   * Attach in-memory `ProductReference` stubs to each PLAN comment that has an
   * entry in `fixtureSubtree.resolvedProducts`. The stubs carry just enough
   * state for `PromptAssemblyService.buildResolvedProductsSection` and
   * `buildPlanProductAnnotation` to render exactly as production does:
   * `displayName`, ordered specs, and a `productCategory` whose `slug` lets
   * `ProductSpecContextService.getExtractionOrderedSpecs` find the configured
   * `primarySpecs`. When no resolvedProducts block is present this is a no-op
   * — identification scenarios run unchanged.
   */
  private attachResolvedProducts(
    subtree: Subtree,
    fixtureSubtree: FixtureSubtree,
    fixturePath: string,
  ): void {
    const resolvedProducts = fixtureSubtree.resolvedProducts;
    if (!resolvedProducts) return;

    for (const planNode of subtree.planNodes) {
      const externalId = planNode.comment.externalId;
      const products = resolvedProducts[externalId];
      if (!products || products.length === 0) continue;

      const refs: ProductReference[] = products.map((product, refIndex) => {
        const ref = this.synthesizeProductReference(product);
        // Labeling reads ref.comment.id and ref.comment.body when assembling
        // the user prompt. Without this wire-up every synthesized ref would
        // be silently dropped at the comment-grouping step.
        ref.comment = planNode.comment;
        // Stamp a stable synthetic ref id so the validation seed-coverage
        // analysis can map labelToRefId → externalId. Production refs always
        // have UUID `id`s; fixture refs need the same so downstream consumers
        // (e.g. ValidationSubtreeRenderer's labelToRefId map) round-trip.
        ref.id = `fx-${externalId}-${refIndex}`;
        return ref;
      });
      planNode.comment.productReferences = refs;
    }

    // Validate that every key in resolvedProducts maps to an existing PLAN
    // node — typos here would silently drop the resolved-products section.
    const planExternalIds = new Set(
      subtree.planNodes.map((n) => n.comment.externalId),
    );
    for (const externalId of Object.keys(resolvedProducts)) {
      if (!planExternalIds.has(externalId)) {
        throw new Error(
          `${fixturePath}: subtree ${fixtureSubtree.id}: resolvedProducts references "${externalId}" but no PLAN comment with that externalId exists in this subtree.`,
        );
      }
    }
  }

  /**
   * Build an in-memory `ProductReference` whose primary candidate's model
   * carries the fixture-supplied specs in the shape `OrderedSpec[]`, and whose
   * `productCategory` carries the slug needed by
   * `ProductSpecContextService.getExtractionOrderedSpecs` to look up
   * `primarySpecs` from disk-backed category configs.
   */
  private synthesizeProductReference(
    product: FixtureResolvedProduct,
  ): ProductReference {
    const ref = new ProductReference();
    const displayName =
      product.displayName ?? `${product.brand} ${product.model}`.trim();

    if (product.categorySlug) {
      const category = new ProductCategory();
      category.slug = product.categorySlug;
      ref.productCategory = category;
    }

    // For unresolved fixture entries we leave candidates empty so the
    // renderer's `[unresolved]` branch fires. We still populate
    // context.identification so the brand/model are visible in the rendered
    // tree just like a real unresolved reference.
    if (!product.unresolved) {
      const model = new ProductModel();
      const brand = new Brand();
      brand.name = product.brand;
      model.brand = brand;
      model.model = product.model;
      model.displayName = displayName;
      model.normalizedName = displayName.toLowerCase();
      model.orderedSpecs = (product.specs ?? []).map((s) => ({
        key: s.name,
        label: s.name,
        value: s.value,
      }));
      if (ref.productCategory) model.productCategory = ref.productCategory;

      const candidate = new ProductReferenceCandidate();
      candidate.model = model;
      candidate.confidence = 100;
      candidate.weight = 1;
      candidate.isPrimary = true;
      candidate.reference = ref;
      ref.candidates = [candidate];
      ref.ambiguousResolution = false;
    } else {
      ref.candidates = [];
      ref.ambiguousResolution = false;
    }

    ref.relevance = 1;
    ref.enabled = true;
    ref.flagged = false;
    ref.resolutionFinished = !product.unresolved;
    ref.context = {
      identification: {
        brand: product.brand,
        model: product.model,
        displayName,
      },
      resolution: {},
    };

    // Labeling-only fields. Identification/extraction fixtures omit these and
    // the corresponding ref properties stay undefined (matching the existing
    // behavior).
    if (product.experience) {
      ref.experience = product.experience as ExperienceType;
    }
    if (product.depth) {
      ref.depth = product.depth as Depth;
    }
    if (product.sentiment) {
      ref.sentiment = product.sentiment as Sentiment;
    }
    if (product.intents?.length) {
      ref.intents = product.intents.map((value) => value as Intent);
    }
    if (product.quotes?.length) {
      ref.quotes = product.quotes.map((quote, index): Quote => {
        const synth: Quote = {
          id: `fx-q-${index}`,
          text: quote.text,
          sentiment: quote.sentiment,
        };
        if (quote.speculative !== undefined) {
          synth.speculative = quote.speculative;
        }
        if (quote.evidence?.features?.length) {
          synth.features = quote.evidence.features.map(toEvidence);
        }
        if (quote.evidence?.useCases?.length) {
          synth.useCases = quote.evidence.useCases.map(toEvidence);
        }
        return synth;
      });
    }
    return ref;
  }

  /**
   * Build the `PhaseInputExtras` bag from the fixture: identification
   * annotations re-keyed by the short id (`c0`, `c1`, ...) the prompt uses,
   * plus extraction knobs lifted verbatim from `fixture.extractionOptions`.
   */
  private buildExtras(
    fixture: FixtureFile,
    subtree: Subtree,
  ): PhaseInputExtras {
    const extras: PhaseInputExtras = {};

    if (fixture.identificationResults) {
      const annotations = new Map<string, LLMMappedProduct[]>();
      // The extraction prompt's PLAN annotation lookup keys on the comment
      // entity's `id` field, but the production map is keyed by short id
      // (c0, c1, ...). To keep both call sites happy we register entries
      // under both keys: short id (for the production lookup convention)
      // and the in-memory comment id we minted in buildContext (for the
      // current PromptAssemblyService implementation that keys on comment.id).
      const externalIdToShortId = new Map<string, string>();
      const externalIdToCommentId = new Map<string, string>();
      subtree.planNodes.forEach((node, index) => {
        externalIdToShortId.set(node.comment.externalId, `c${index}`);
        externalIdToCommentId.set(node.comment.externalId, node.comment.id);
      });
      for (const [externalId, products] of Object.entries(
        fixture.identificationResults,
      )) {
        const shortId = externalIdToShortId.get(externalId);
        if (shortId) annotations.set(shortId, products);
        const commentId = externalIdToCommentId.get(externalId);
        if (commentId) annotations.set(commentId, products);
      }
      extras.planProductAnnotations = annotations;
    }

    const opts = fixture.extractionOptions;
    if (opts) {
      if (opts.maxFocusCategories !== undefined)
        extras.maxFocusCategories = opts.maxFocusCategories;
      if (opts.maxQuotesCeiling !== undefined)
        extras.maxQuotesCeiling = opts.maxQuotesCeiling;
      if (opts.validSpecNames !== undefined)
        extras.validSpecNames = opts.validSpecNames;
      if (opts.stripContext !== undefined)
        extras.stripContext = opts.stripContext;
    }

    return extras;
  }
}

function toEvidence(entry: FixtureEvidenceEntry): Evidence {
  return {
    label: entry.label,
    ...(entry.sentiment !== undefined && { sentiment: entry.sentiment }),
  };
}
