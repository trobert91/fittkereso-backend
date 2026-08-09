import {
  Subtree,
  ValidationSubtreeRenderer,
} from "@ebike-backend/thread-processor";
import { CandidateAggregate } from "../execution/candidate-aggregate.types";
import { ExpectedIssueSeed } from "../scenario/scenario.types";
import {
  CandidateSeedResult,
  ExpectedSeedInSubtree,
  ScenarioSeedRow,
  ScenarioSeedSummary,
  SubtreeReportSection,
  SubtreeSeedAnalysis,
} from "./report-writer.service";

/**
 * Build a `refLabel` (A, B, C, ...) → `comment.externalId` map for the given
 * subtree. Mirrors `ValidationSubtreeRenderer.render`'s label-assignment
 * walk: refs are labeled in DFS order across all PLAN nodes, in the order
 * they appear on each comment's `productReferences[]`.
 */
export function buildLabelToExternalIdMap(
  subtree: Subtree,
  renderer: ValidationSubtreeRenderer,
): Map<string, string> {
  // Use the renderer's own labelToRefId so we always agree on the label scheme.
  const { labelToRefId } = renderer.render(subtree);

  // refId → externalId
  const refIdToExternalId = new Map<string, string>();
  for (const node of subtree.planNodes) {
    for (const ref of node.comment.productReferences ?? []) {
      if (ref.id) refIdToExternalId.set(ref.id, node.comment.externalId);
    }
  }

  const labelToExternalId = new Map<string, string>();
  for (const [label, refId] of labelToRefId) {
    const ext = refIdToExternalId.get(refId);
    if (ext) labelToExternalId.set(label, ext);
  }
  return labelToExternalId;
}

/**
 * For a single subtree, compute per-candidate found/missed for each seed whose
 * comment renders in this subtree. Reads each candidate's representative run.
 */
export function buildSubtreeSeedAnalysis(
  subtree: Subtree,
  candidates: CandidateAggregate[],
  manifest: ExpectedIssueSeed[],
  renderer: ValidationSubtreeRenderer,
): SubtreeSeedAnalysis {
  const labelToExternalId = buildLabelToExternalIdMap(subtree, renderer);

  // Reverse: externalId → set of refLabels (a comment may have multiple refs).
  const externalIdToLabels = new Map<string, string[]>();
  for (const [label, externalId] of labelToExternalId) {
    const list = externalIdToLabels.get(externalId) ?? [];
    list.push(label);
    externalIdToLabels.set(externalId, list);
  }

  // The seeds this subtree is responsible for: those whose comment has at
  // least one rendered refLabel here. We pick the FIRST refLabel for the
  // expected match — the seeded mistake lives on the comment's first ref by
  // convention (boundary_violation merges into ref 0, wrong_product mutates
  // ref 0, etc.).
  const expectedSeeds: ExpectedSeedInSubtree[] = [];
  for (const seed of manifest) {
    const labels = externalIdToLabels.get(seed.commentExternalId);
    if (!labels || labels.length === 0) continue;
    expectedSeeds.push({ ...seed, refLabel: labels[0] });
  }

  const candidateResults: CandidateSeedResult[][] = expectedSeeds.map((seed) =>
    candidates.map((aggregate) => evaluateCandidateOnSeed(aggregate, seed)),
  );

  return { expectedSeeds, candidateResults };
}

/**
 * Walk every run of this candidate and decide whether the seed was flagged.
 * `found` and `emittedTypes` reflect the representative run only (back-compat
 * with single-run-style display), but `runFoundCount` / `runTotal` cover all
 * runs so reports can show cross-run aggregates.
 */
function evaluateCandidateOnSeed(
  aggregate: CandidateAggregate,
  seed: ExpectedSeedInSubtree,
): CandidateSeedResult {
  const repIndex = aggregate.representativeRunIndex;
  const repRun = aggregate.runs[repIndex];
  const repRefs = extractRefs(repRun?.parsed);
  const emittedTypes: string[] = [];
  let repFound = false;
  if (repRefs) {
    for (const ref of repRefs) {
      if (ref.refLabel !== seed.refLabel) continue;
      for (const issue of ref.issues) {
        emittedTypes.push(issue.type);
        if (issue.type === seed.expectedIssueType) repFound = true;
      }
    }
  }

  let runFoundCount = 0;
  for (const run of aggregate.runs) {
    const refs = extractRefs(run?.parsed);
    if (!refs) continue;
    const flagged = refs.some(
      (ref) =>
        ref.refLabel === seed.refLabel &&
        ref.issues.some((issue) => issue.type === seed.expectedIssueType),
    );
    if (flagged) runFoundCount++;
  }

  return {
    candidateId: aggregate.candidateId,
    found: repFound,
    emittedTypes,
    runFoundCount,
    runTotal: aggregate.runs.length,
  };
}

interface ParsedRefShape {
  refLabel: string;
  issues: Array<{ type: string }>;
}

function extractRefs(parsed: unknown): ParsedRefShape[] | null {
  if (parsed === undefined || parsed === null) return null;
  if (typeof parsed !== "object") return null;
  const obj = parsed as { refs?: unknown };
  if (!Array.isArray(obj.refs)) return null;
  const out: ParsedRefShape[] = [];
  for (const entry of obj.refs as Array<Record<string, unknown>>) {
    if (typeof entry?.refLabel !== "string") continue;
    const issues = Array.isArray(entry.issues) ? entry.issues : [];
    const cleanIssues: Array<{ type: string }> = [];
    for (const issue of issues as Array<Record<string, unknown>>) {
      if (typeof issue?.type === "string")
        cleanIssues.push({ type: issue.type });
    }
    out.push({ refLabel: entry.refLabel, issues: cleanIssues });
  }
  return out;
}

/**
 * Roll up per-subtree analyses into a scenario-wide table. Each manifest seed
 * appears at most once. If multiple subtrees render the same seed (shouldn't
 * happen with a well-built fixture), the first wins.
 */
export function buildScenarioSeedSummary(
  manifest: ExpectedIssueSeed[],
  candidateIds: string[],
  subtreeReports: SubtreeReportSection[],
): ScenarioSeedSummary {
  // Index analyses by externalId.
  const seedToSubtree = new Map<
    string,
    {
      subtreeLabel: string;
      expected: ExpectedSeedInSubtree;
      results: CandidateSeedResult[];
    }
  >();
  for (const section of subtreeReports) {
    const analysis = section.seedAnalysis;
    if (!analysis) continue;
    analysis.expectedSeeds.forEach((seed, i) => {
      if (!seedToSubtree.has(seed.commentExternalId)) {
        seedToSubtree.set(seed.commentExternalId, {
          subtreeLabel: section.subtreeCase.label,
          expected: seed,
          results: analysis.candidateResults[i],
        });
      }
    });
  }

  const rows: ScenarioSeedRow[] = [];
  let unmatched = 0;
  for (const seed of manifest) {
    const hit = seedToSubtree.get(seed.commentExternalId);
    if (!hit) {
      unmatched++;
      continue;
    }
    const byCandidate: ScenarioSeedRow["byCandidate"] = {};
    for (const id of candidateIds) {
      const res = hit.results.find((r) => r.candidateId === id);
      byCandidate[id] = {
        repFound: res ? res.found : false,
        runFoundCount: res ? res.runFoundCount : 0,
        runTotal: res ? res.runTotal : 0,
      };
    }
    rows.push({
      commentExternalId: seed.commentExternalId,
      expectedIssueType: seed.expectedIssueType,
      note: seed.note,
      subtreeLabel: hit.subtreeLabel,
      refLabel: hit.expected.refLabel,
      byCandidate,
    });
  }

  const totals: ScenarioSeedSummary["totals"] = {};
  for (const id of candidateIds) {
    totals[id] = { found: 0, missed: 0, runFound: 0, runTotal: 0 };
  }
  for (const row of rows) {
    for (const id of candidateIds) {
      const cell = row.byCandidate[id];
      if (!cell) continue;
      if (cell.repFound) totals[id].found++;
      else totals[id].missed++;
      totals[id].runFound += cell.runFoundCount;
      totals[id].runTotal += cell.runTotal;
    }
  }

  return { rows, totals, unmatchedSeedCount: unmatched };
}
