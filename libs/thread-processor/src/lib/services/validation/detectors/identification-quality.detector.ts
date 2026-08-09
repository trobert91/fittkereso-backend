import { Injectable } from "@nestjs/common";
import {
  ProductReference,
  ValidationIssue,
  ValidationIssueType,
} from "@ebike-backend/database";
import {
  DetectionContext,
  IssueDetector,
} from "../../../interfaces/issue-detector.interface";
import { buildValidationIssue } from "../validation-issue-types";

/**
 * Contrast-cue tokens — phrases the commenter writes when explicitly distinguishing
 * one product from another (e.g. "newer version", "(SD)" vs "(SB)"). When one of
 * these is present in the ref's own quotes AND the LLM still emitted a model that
 * exactly matches a cheat-sheet entry, that's the `cheat_sheet_collapse_with_contrast_cue`
 * failure mode. Scoped to the ref's quotes (not the whole comment body) so a
 * cue attached to a sibling product's evidence does not flag this ref.
 */
const CONTRAST_CUE_PATTERNS: readonly RegExp[] = [
  /\bnewer version\b/i,
  /\bolder version\b/i,
  /\bolder one\b/i,
  /\bdifferent model\b/i,
  /\((?:s[bd]|sb|sd)\)/i, // (SB), (SD), (Sb), etc.
];

/**
 * Reads `ref.context.identification` and the comment body. Emits issues that
 * surface the LLM identification step's quality without re-running it.
 *
 * Issues:
 * - `cheat_sheet_collapse_with_contrast_cue` — contrast cue present yet model
 *   exactly matches a cheat-sheet entry.
 */
@Injectable()
export class IdentificationQualityDetector implements IssueDetector {
  readonly type: ValidationIssueType = "cheat_sheet_collapse_with_contrast_cue";

  detect(ref: ProductReference, _ctx: DetectionContext): ValidationIssue[] {
    const out: ValidationIssue[] = [];
    const identification = ref.context?.identification;
    if (!identification) return out;

    const model = identification.model?.trim() ?? "";
    const quoteText = (ref.quotes ?? []).map((q) => q.text ?? "").join(" ");

    // cheat_sheet_collapse_with_contrast_cue — contrast cue + cheat-sheet match.
    //    The cheat-sheet snapshot is not currently persisted on the ref. Without
    //    it, the best signal we have is "the ref's own quotes carry a contrast
    //    cue AND the emitted model is identical to the registry key shape (no
    //    new variant suffix in the quoted evidence)." Scanning the ref's quotes
    //    rather than the whole comment body avoids attributing a sibling
    //    product's contrast cue to this ref.
    if (this.hasContrastCue(quoteText) && model.length > 0) {
      const modelInQuotes = this.quotesMentionModel(quoteText, model);
      if (!modelInQuotes) {
        out.push(
          buildValidationIssue("cheat_sheet_collapse_with_contrast_cue", {
            source: "deterministic",
            status: "pending",
            reasoning: `Ref's quotes contain a contrast cue but the emitted model "${model}" does not appear verbatim in them — likely collapsed to a cheat-sheet entry.`,
          }),
        );
      }
    }

    return out;
  }

  private hasContrastCue(text: string): boolean {
    return CONTRAST_CUE_PATTERNS.some((re) => re.test(text));
  }

  private quotesMentionModel(quoteText: string, model: string): boolean {
    if (!model) return false;
    const haystack = quoteText.toLowerCase();
    const needle = model.toLowerCase();
    if (haystack.includes(needle)) return true;
    // Try stripped-of-spaces forms — `G8 SD` vs `G8SD`.
    const stripped = needle.replace(/\s+/g, "");
    if (stripped.length >= 2 && haystack.replace(/\s+/g, "").includes(stripped))
      return true;
    return false;
  }
}
