import {
  Subtree,
  ThreadContext,
  LLMMappedProduct,
} from "@ebike-backend/thread-processor";
import { Thread } from "@ebike-backend/database";
import { ResolvedSubtreeCase } from "../scenario/scenario.types";

/**
 * Phase-specific extras the input provider attaches to the PhaseInput. Each
 * phase reads only the fields relevant to it; the rest is ignored. Kept as a
 * single optional bag rather than a per-phase union to avoid touching the
 * runner contract every time a new phase shows up.
 */
export interface PhaseInputExtras {
  /**
   * Identification step output for this subtree, keyed by short id (`c0`,
   * `c1`, ...). Drives the `[products: ...]` annotation that
   * `PromptAssemblyService.buildCommentsSection` writes onto PLAN nodes when
   * extraction runs. Identification phase ignores this field.
   */
  planProductAnnotations?: Map<string, LLMMappedProduct[]>;
  /** Extraction-only: how many top categories to include in the system prompt scope section. */
  maxFocusCategories?: number;
  /** Extraction-only: per-comment quote count ceiling (validation knob — does not change the prompt). */
  maxQuotesCeiling?: number;
  /** Extraction-only: spec names accepted by extraction validation. Empty = accept all. */
  validSpecNames?: string[];
  /** Extraction-only: whether to omit [CONTEXT] nodes from the rendered tree. Default true. */
  stripContext?: boolean;
}

/**
 * What a phase runner needs to invoke a candidate. Both real-thread and fixture
 * input providers produce this shape so the phase runners are oblivious to the
 * source.
 */
export interface PhaseInput {
  subtree: Subtree;
  context: ThreadContext;
  thread?: Thread;
  /** Phase-specific extras (see PhaseInputExtras). Always present; may be empty. */
  extras: PhaseInputExtras;
}

/**
 * One concrete (subtreeCase, PhaseInput) pair after the InputProvider has
 * loaded the thread / fixture and built the corresponding subtree.
 * The `case.inputId` field identifies which named input entry this came from.
 */
export interface ResolvedPhaseCase {
  case: ResolvedSubtreeCase;
  input: PhaseInput;
}
