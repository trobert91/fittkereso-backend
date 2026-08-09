import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import {
  ExtractionResponseSchema,
  IdentificationResponseSchema,
  LabelingResponseSchema,
} from "@ebike-backend/thread-processor";
import { ExpectationsSpec, MustCheck } from "../scenario/scenario.types";
import { CandidateRunResult } from "../phases/phase-runner.interface";

// ─── Per-run check result ────────────────────────────────────────────────────

export interface DeterministicCheckResult {
  schemaCheck: { ran: boolean; passed: boolean; errors: string[] };
  mustContain: Array<{ check: MustCheck; passed: boolean; reason?: string }>;
  mustNotContain: Array<{ check: MustCheck; passed: boolean; reason?: string }>;
  /** True only if every applicable check passed. */
  allPassed: boolean;
}

@Injectable()
export class DeterministicChecksService {
  private readonly logger = new CustomLogger(DeterministicChecksService.name);

  /**
   * Evaluate the deterministic guards for a single run. Does NOT mutate the
   * run result — the caller is responsible for downgrading run.succeeded /
   * run.failureReason to 'deterministicCheckFail' when allPassed is false.
   */
  evaluate(
    run: CandidateRunResult,
    expectations: ExpectationsSpec,
  ): DeterministicCheckResult {
    const schemaCheck = this.runSchemaCheck(run, expectations.schemaCheck);
    const mustContain = (expectations.mustContain ?? []).map((check) => ({
      check,
      ...this.runMustContain(run, check, true),
    }));
    const mustNotContain = (expectations.mustNotContain ?? []).map((check) => ({
      check,
      ...this.runMustContain(run, check, false),
    }));

    const allPassed =
      (!schemaCheck.ran || schemaCheck.passed) &&
      mustContain.every((c) => c.passed) &&
      mustNotContain.every((c) => c.passed);

    return { schemaCheck, mustContain, mustNotContain, allPassed };
  }

  // ─── Schema check ──────────────────────────────────────────────────────────

  private runSchemaCheck(
    run: CandidateRunResult,
    schemaId: string | undefined,
  ): { ran: boolean; passed: boolean; errors: string[] } {
    if (!schemaId) {
      return { ran: false, passed: true, errors: [] };
    }
    if (run.parsed === undefined) {
      return {
        ran: true,
        passed: false,
        errors: ["no parsed output to validate (response was unparseable)"],
      };
    }

    const zodSchema = this.resolveSchema(schemaId);
    if (!zodSchema) {
      return {
        ran: true,
        passed: false,
        errors: [`unknown schemaCheck id: "${schemaId}"`],
      };
    }

    const result = zodSchema.safeParse(run.parsed);
    if (result.success) {
      return { ran: true, passed: true, errors: [] };
    }
    return {
      ran: true,
      passed: false,
      errors: result.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
    };
  }

  /** Resolve a scenario-supplied schemaCheck id to a Zod schema. */
  private resolveSchema(
    id: string,
  ):
    | {
        safeParse: (input: unknown) => {
          success: boolean;
          error?: {
            issues: Array<{ path: (string | number)[]; message: string }>;
          };
        };
      }
    | undefined {
    switch (id) {
      case "subtree-identification.schema":
        return IdentificationResponseSchema as never;
      case "subtree-extraction.schema":
        return ExtractionResponseSchema as never;
      case "quote-labeling.schema":
        return LabelingResponseSchema as never;
      default:
        return undefined;
    }
  }

  // ─── mustContain / mustNotContain ──────────────────────────────────────────

  private runMustContain(
    run: CandidateRunResult,
    check: MustCheck,
    expectPresent: boolean,
  ): { passed: boolean; reason?: string } {
    const found = this.evaluateCheck(run, check);
    const passed = expectPresent ? found : !found;
    if (passed) return { passed };
    return {
      passed,
      reason: expectPresent
        ? `expected ${this.checkSummary(check)} but did not find it`
        : `expected NO ${this.checkSummary(check)} but found one`,
    };
  }

  private evaluateCheck(run: CandidateRunResult, check: MustCheck): boolean {
    switch (check.kind) {
      case "regex":
        return this.checkRegex(run, check);
      case "substring":
        return this.checkSubstring(run, check);
      case "productMention":
        return this.checkProductMention(run, check);
      default: {
        const _exhaustive: never = check;
        throw new Error(`Unknown check kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private checkRegex(
    run: CandidateRunResult,
    check: Extract<MustCheck, { kind: "regex" }>,
  ): boolean {
    const target = this.resolveTarget(
      run,
      check.appliesTo ?? "stringifiedParsed",
    );
    try {
      const regex = new RegExp(check.pattern, "i");
      return regex.test(target);
    } catch (error: unknown) {
      this.logger.warn(
        `Invalid regex in mustContain/mustNotContain: ${check.pattern}`,
      );
      return false;
    }
  }

  private checkSubstring(
    run: CandidateRunResult,
    check: Extract<MustCheck, { kind: "substring" }>,
  ): boolean {
    const target = this.resolveTarget(
      run,
      check.appliesTo ?? "stringifiedParsed",
    );
    return target.toLowerCase().includes(check.value.toLowerCase());
  }

  private checkProductMention(
    run: CandidateRunResult,
    check: Extract<MustCheck, { kind: "productMention" }>,
  ): boolean {
    // Walk the parsed output looking for { brand, model } pairs that match
    // (case-insensitive). We support the identification schema shape here:
    //   { comments: [{ commentId, products: [{ brand, model, ... }] }] }
    // and also a flat fallback (any nested object with brand+model fields).
    const wantBrand = check.brand.toLowerCase();
    const wantModel = check.model.toLowerCase();

    const visit = (node: unknown): boolean => {
      if (node === null || node === undefined) return false;
      if (Array.isArray(node)) {
        return node.some(visit);
      }
      if (typeof node === "object") {
        const obj = node as Record<string, unknown>;
        const brand =
          typeof obj["brand"] === "string"
            ? (obj["brand"] as string).toLowerCase()
            : null;
        const model =
          typeof obj["model"] === "string"
            ? (obj["model"] as string).toLowerCase()
            : null;
        if (brand && model && brand === wantBrand && model === wantModel) {
          return true;
        }
        return Object.values(obj).some(visit);
      }
      return false;
    };

    return visit(run.parsed);
  }

  private resolveTarget(
    run: CandidateRunResult,
    appliesTo: "rawContent" | "stringifiedParsed",
  ): string {
    if (appliesTo === "rawContent") return run.rawContent ?? "";
    if (run.parsed === undefined) return run.rawContent ?? "";
    try {
      return JSON.stringify(run.parsed);
    } catch {
      return run.rawContent ?? "";
    }
  }

  private checkSummary(check: MustCheck): string {
    switch (check.kind) {
      case "regex":
        return `regex /${check.pattern}/`;
      case "substring":
        return `substring "${check.value}"`;
      case "productMention":
        return `product ${check.brand} ${check.model}`;
    }
  }
}
