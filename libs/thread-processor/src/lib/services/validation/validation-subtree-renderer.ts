import { Injectable } from "@nestjs/common";
import {
  Evidence,
  getPrimaryModel,
  ProductReference,
  Quote,
} from "@ebike-backend/database";
import { Subtree } from "../../models/subtree.model";

export interface RenderedValidationSubtree {
  rendered: string;
  labelToRefId: Map<string, string>;
  /** Maps the @authorName label (as rendered) to comment id. First-write-wins on collision. */
  labelToCommentId: Map<string, string>;
}

function toAlphabeticLabel(seq: number): string {
  let n = seq;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

@Injectable()
export class ValidationSubtreeRenderer {
  render(subtree: Subtree): RenderedValidationSubtree {
    const lines: string[] = [];
    const labelToRefId = new Map<string, string>();
    const labelToCommentId = new Map<string, string>();
    let labelSeq = 0;

    const planCommentIds = new Set(subtree.planNodes.map((n) => n.comment.id));

    for (const node of subtree.nodes) {
      const { comment, nodeType, depth } = node;
      const indent = "  ".repeat(depth);

      if (nodeType === "CONTEXT") {
        lines.push(
          `${indent}[CONTEXT] @${comment.authorName ?? "anon"}: "${this.truncate(comment.body ?? "", 400)}"`,
        );
        continue;
      }

      // PLAN node — only render refs for comments that are in scope for this LLM call
      if (!planCommentIds.has(comment.id)) {
        lines.push(
          `${indent}[CONTEXT] @${comment.authorName ?? "anon"}: "${this.truncate(comment.body ?? "", 400)}"`,
        );
        continue;
      }

      const commentLabel = `@${comment.authorName ?? "anon"}`;
      if (!labelToCommentId.has(commentLabel)) {
        labelToCommentId.set(commentLabel, comment.id);
      }
      lines.push(
        `${indent}[VALIDATE] ${commentLabel}: "${this.truncate(comment.body ?? "", 800)}"`,
      );
      for (const ref of comment.productReferences ?? []) {
        const label = toAlphabeticLabel(labelSeq++);
        labelToRefId.set(label, ref.id);
        lines.push(this.renderRefHeader(ref, label, indent));
        lines.push(`${indent}    experience: ${ref.experience ?? "-"}`);
        lines.push(`${indent}    depth: ${ref.depth ?? "-"}`);
        lines.push(`${indent}    sentiment: ${ref.sentiment ?? "-"}`);
        lines.push(
          `${indent}    intents: ${(ref.intents ?? []).join(", ") || "-"}`,
        );
        if ((ref.quotes ?? []).length > 0) {
          lines.push(`${indent}    quotes:`);
          for (const quote of ref.quotes ?? []) {
            lines.push(this.renderQuote(quote, indent));
          }
        }
      }
      lines.push("");
    }

    return { rendered: lines.join("\n"), labelToRefId, labelToCommentId };
  }

  private renderRefHeader(
    ref: ProductReference,
    label: string,
    indent: string,
  ): string {
    const fallback =
      `${ref.context?.identification?.brand ?? ""} ${ref.context?.identification?.model ?? ""}`.trim() ||
      "Unresolved";
    const resolved = getPrimaryModel(ref)?.displayName ?? fallback;
    return `${indent}  Ref ${label} (${resolved}):`;
  }

  private renderQuote(quote: Quote, indent: string): string {
    const qualitySegment = quote.quality ? ` quality=${quote.quality}` : "";
    const speculativeSegment = ` speculative=${quote.speculative === true}`;
    const head = `${indent}      [${quote.id}] "${this.truncate(quote.text ?? "", 200)}" sentiment=${quote.sentiment}${qualitySegment}${speculativeSegment}`;
    const features = this.renderEvidenceBlock(
      "features",
      quote.features ?? [],
      indent,
    );
    const useCases = this.renderEvidenceBlock(
      "useCases",
      quote.useCases ?? [],
      indent,
    );
    return [head, features, useCases].filter((s) => s.length > 0).join("\n");
  }

  private renderEvidenceBlock(
    collection: "features" | "useCases",
    entries: Evidence[],
    indent: string,
  ): string {
    if (entries.length === 0) return "";
    return entries
      .map((entry, index) => {
        return `${indent}        ${collection}: [${index}] ${entry.label}/${entry.sentiment ?? "inherit"}`;
      })
      .join("\n");
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + "…" : text;
  }
}
