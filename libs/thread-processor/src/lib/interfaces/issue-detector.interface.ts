import {
  IssueLabelConfig,
  ProductReference,
  UserComment,
  ValidationIssue,
  ValidationIssueType,
} from "@ebike-backend/database";

export interface DetectionContext {
  commentBody: string;
  comment: UserComment;
  issueLabelsIndex: Map<string, IssueLabelConfig>;
}

export interface IssueDetector {
  /** The ValidationIssueType this detector handles. */
  readonly type: ValidationIssueType;

  /**
   * Inspect the ref and return issues for its type. Pure: must NOT
   * mutate `ref` or anything reachable from it.
   */
  detect(ref: ProductReference, ctx: DetectionContext): ValidationIssue[];
}

export const ISSUE_DETECTORS = Symbol("ISSUE_DETECTORS");
