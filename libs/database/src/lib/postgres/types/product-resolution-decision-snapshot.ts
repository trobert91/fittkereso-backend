/** Raw `FinalDecision` snapshot from the resolution pipeline (`libs/resolution`),
 *  persisted verbatim onto a `product_resolution`-flow row. Deliberately kept
 *  separate from the `decision` enum column, which has different,
 *  workflow-specific values (`auto_accepted`/`pending_review`/`approved`/`rejected`). */
export interface ProductResolutionDecisionSnapshot {
  kind: 'matcher_accept' | 'matcher_reject' | 'llm_resolved' | 'llm_unresolved';
  /** 0-100 integer. */
  confidence: number;
  reason: string;
  selectedCandidates: Array<{
    candidateId: string;
    confidence: number;
    reason?: string;
  }>;
  evidenceSummary?: string;
}
