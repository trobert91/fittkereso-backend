import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  ProductModel,
  ProductModelRepository,
  ProductResolution,
  ProductResolutionRepository,
  type ProductResolutionCandidateRecord,
  type ProductResolutionDecisionEntry,
  type SpecMatchDetails,
} from '@fittkereso-backend/database';

@Injectable()
export class ProductResolutionTools {
  constructor(
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly productRepo: ProductModelRepository,
  ) {}

  @Tool({
    name: 'get_product_resolution',
    description:
      'Get a ProductResolution review-queue row in full, with everything joined — workflow state (flow/origin/status/accepted/decidedBy), the append-only decisions log, scores (similarity, decisionConfidence, priority + breakdown), review triggers, the AI review verdict, the anchorKey/fingerprint dedup keys, the input snapshot the decision was made from, the raw pipeline decision snapshot, per-spec match details, and every candidate considered with its gate outcomes. Candidate ids and the joined products (productA/productB/resolvedProduct, plus the sourceRecord with its source and current product) are hydrated live from the catalog, so the stored decision can be compared against the products as they are now. Use to debug why the resolution pipeline matched, created, or rejected — or why duplicate detection proposed a pair.',
    parameters: z.object({
      resolutionId: z.string().describe('ProductResolution UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getProductResolution(args: { resolutionId: string }): Promise<string> {
    const resolution = await this.resolutionRepo.findForAction(
      args.resolutionId,
    );

    if (!resolution) {
      return `Error: no ProductResolution found with id ${args.resolutionId}`;
    }

    const candidates = resolution.candidates ?? [];
    const [liveCandidates, joined] = await Promise.all([
      this.loadCandidateProducts(candidates),
      // findForAction loads the joined products without their brand/category/
      // aliases, which is all this tool wants to show — so re-read them here
      // rather than render "?" for a brand the product does have.
      this.loadProductDetails([
        resolution.productA?.id,
        resolution.productB?.id,
        resolution.resolvedProduct?.id,
        resolution.sourceRecord?.model?.id,
      ]),
    ]);

    this.hydrateJoinedProducts(resolution, joined);

    const L: string[] = [];

    this.renderHeader(L, resolution);
    this.renderScores(L, resolution);
    this.renderJoinedProducts(L, resolution);
    this.renderSourceRecord(L, resolution);
    this.renderDecisions(L, resolution.decisions ?? []);
    this.renderAiReview(L, resolution);
    this.renderCandidates(L, candidates, liveCandidates);
    this.renderSpecMatchDetails(
      L,
      '## Spec Match Details',
      resolution.specMatchDetails,
    );
    this.renderInputSnapshot(L, resolution);
    this.renderDecisionSnapshot(L, resolution);

    return L.join('\n');
  }

  /**
   * Candidate records deliberately store no copy of the candidate's own entity
   * data, so it has to be loaded fresh — and the live version is the only
   * correct one to review against, since acting on the row acts on the product
   * as it is now, not as it was when the row was written.
   */
  private loadCandidateProducts(
    candidates: ProductResolutionCandidateRecord[],
  ): Promise<Map<string, ProductModel>> {
    return this.loadProductDetails(candidates.map((c) => c.candidateId));
  }

  /** Batch-loads products with the relations this tool renders. */
  private async loadProductDetails(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, ProductModel>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) {
      return new Map();
    }

    const products = await this.productRepo.getAll({
      where: unique.map((id) => ({ id })),
      relations: ['brand', 'productCategory', 'aliases'],
    });

    return new Map(products.map((p) => [p.id, p]));
  }

  /** Swaps the relation-thin joined products for their fully-loaded versions. */
  private hydrateJoinedProducts(
    r: ProductResolution,
    joined: Map<string, ProductModel>,
  ): void {
    r.productA = (r.productA && joined.get(r.productA.id)) ?? r.productA;
    r.productB = (r.productB && joined.get(r.productB.id)) ?? r.productB;
    r.resolvedProduct =
      (r.resolvedProduct && joined.get(r.resolvedProduct.id)) ??
      r.resolvedProduct;
    if (r.sourceRecord?.model) {
      r.sourceRecord.model =
        joined.get(r.sourceRecord.model.id) ?? r.sourceRecord.model;
    }
  }

  private renderHeader(L: string[], r: ProductResolution): void {
    L.push('# Product Resolution');
    L.push(`- **ID**: ${r.id}`);
    L.push(`- **Flow**: ${r.flow}`);
    if (r.origin) L.push(`- **Origin**: ${r.origin}`);
    L.push(`- **Status**: ${r.status}`);
    L.push(`- **Accepted**: ${r.accepted}`);
    L.push(`- **Decided By**: ${r.decidedBy ?? '(undecided)'}`);
    L.push(`- **Anchor Key**: ${r.anchorKey ?? '(none)'}`);
    L.push(`- **Fingerprint**: ${r.fingerprint ?? '(none)'}`);
    L.push(`- **Created At**: ${this.ts(r.createdAt)}`);
    L.push(`- **Last Seen At**: ${this.ts(r.lastSeenAt)}`);
    L.push(`- **Reviewed At (human touch)**: ${this.ts(r.reviewedAt)}`);
    if (r.reviewNote) L.push(`- **Review Note**: ${r.reviewNote}`);
    if (r.mergedAt) L.push(`- **Merged At**: ${this.ts(r.mergedAt)}`);
    if (r.pendingReasons && r.pendingReasons.length > 0) {
      L.push(`- **Pending Reasons**: ${r.pendingReasons.join(', ')}`);
    }
    L.push('');
  }

  private renderScores(L: string[], r: ProductResolution): void {
    L.push('## Scores');
    L.push(`- **Similarity Score**: ${r.similarityScore}`);
    L.push(`- **Decision Confidence**: ${r.decisionConfidence ?? '(none)'}`);
    L.push(`- **Priority**: ${r.priority ?? '(none)'}`);
    L.push(`- **Priority Computed At**: ${this.ts(r.priorityComputedAt)}`);

    // NULL and [] are different values here — never classified (ineligible for
    // every automated path) vs. classified and nothing fired.
    const triggers = r.reviewTriggers;
    L.push(
      `- **Review Triggers**: ${
        triggers == null
          ? '(never classified)'
          : triggers.length === 0
            ? '[] (classified, none fired)'
            : triggers.join(', ')
      }`,
    );

    const breakdown = r.priorityBreakdown;
    if (breakdown) {
      L.push('- **Priority Breakdown**:');
      for (const [key, value] of Object.entries(breakdown)) {
        L.push(`  - ${key}: ${this.scalar(value)}`);
      }
    }
    L.push('');
  }

  private renderJoinedProducts(L: string[], r: ProductResolution): void {
    const entries: Array<[string, ProductModel | null | undefined]> = [
      ['Product A', r.productA],
      ['Product B', r.productB],
      ['Resolved Product', r.resolvedProduct],
    ];

    const present = entries.filter(([, product]) => !!product);
    if (present.length === 0) {
      return;
    }

    L.push('## Joined Products');
    for (const [label, product] of present) {
      L.push(`### ${label}`);
      this.renderProductLines(L, product as ProductModel, '- ');
      L.push('');
    }
  }

  private renderSourceRecord(L: string[], r: ProductResolution): void {
    L.push('## Source Record (the scraped listing)');
    const record = r.sourceRecord;
    if (!record) {
      L.push('- (none — not backfilled, or the record was deleted)');
      L.push('');
      return;
    }

    L.push(`- **ID**: ${record.id}`);
    L.push(`- **URL**: ${record.url ?? '(none)'}`);
    L.push(`- **Source**: ${record.source?.name ?? '(none)'}`);
    L.push(`- **External ID**: ${record.externalId ?? '(none)'}`);
    L.push(`- **Spec Valid**: ${record.specValid}`);
    L.push(`- **Last Updated**: ${this.ts(record.lastUpdated)}`);
    if (record.normalizedSourceName) {
      L.push(`- **Normalized Source Name**: ${record.normalizedSourceName}`);
    }

    // The product the listing sits on *now* — what a corrective action acts on,
    // which can differ from resolvedProduct after a later merge or split.
    if (record.model) {
      L.push('- **Current Product**:');
      this.renderProductLines(L, record.model, '  - ');
    } else {
      L.push('- **Current Product**: (none)');
    }
    L.push('');
  }

  private renderDecisions(
    L: string[],
    decisions: ProductResolutionDecisionEntry[],
  ): void {
    L.push(`## Decisions (${decisions.length})`);
    if (decisions.length === 0) {
      L.push("- (empty — index 0 should always be the producing system's own");
      L.push('  decision, so an empty log is itself the finding)');
      L.push('');
      return;
    }

    decisions.forEach((entry, index) => {
      const seed = index === 0 ? ' — system seed' : '';
      L.push(`### [${index}] ${entry.actor} · ${entry.verdict}${seed}`);
      L.push(`- **At**: ${entry.at}`);
      L.push(`- **Action Kind**: ${entry.action?.kind ?? '(none)'}`);
      if (entry.action?.productId) {
        L.push(`- **Action Product**: ${entry.action.productId}`);
      }
      if (entry.action?.sourceProductId) {
        L.push(`- **Action Source Product**: ${entry.action.sourceProductId}`);
      }
      if (entry.action?.targetProductId) {
        L.push(`- **Action Target Product**: ${entry.action.targetProductId}`);
      }
      const recordIds = entry.action?.sourceRecordIds ?? [];
      if (recordIds.length > 0) {
        L.push(
          `- **Action Source Records (${recordIds.length})**: ${recordIds.join(', ')}`,
        );
      }
      L.push(`- **Action Performed**: ${entry.actionPerformed}`);
      if (entry.performedAt) L.push(`- **Performed At**: ${entry.performedAt}`);
      if (entry.error) L.push(`- **Error**: ${entry.error}`);
      if (entry.note) L.push(`- **Note**: ${entry.note}`);
      L.push('');
    });
  }

  private renderAiReview(L: string[], r: ProductResolution): void {
    L.push('## AI Review');
    L.push(`- **Reviewed At**: ${this.ts(r.aiReviewedAt)}`);
    L.push(`- **Confidence**: ${r.aiConfidence ?? '(none)'}`);

    // aiReviewFingerprint IS DISTINCT FROM fingerprint means the situation
    // changed since the review, so the row is eligible for review again.
    const stale =
      r.aiReviewFingerprint && r.aiReviewFingerprint !== r.fingerprint
        ? ' (STALE — differs from current fingerprint, row is re-reviewable)'
        : '';
    L.push(
      `- **Reviewed Fingerprint**: ${r.aiReviewFingerprint ?? '(none)'}${stale}`,
    );

    const review = r.aiReview;
    if (!review) {
      L.push('- **Verdict**: (never reviewed)');
      L.push('');
      return;
    }

    L.push(`- **Verdict**: ${review.verdict}`);
    L.push(`- **Recommended Action**: ${review.recommendedAction}`);
    if (review.targetProductId) {
      L.push(`- **Target Product**: ${review.targetProductId}`);
    }
    L.push(`- **Executed**: ${review.executed}`);
    L.push(`- **Model**: ${review.model}`);
    if (review.costUsd !== undefined) {
      L.push(`- **Cost USD**: ${review.costUsd}`);
    }
    if (review.evidenceCited && review.evidenceCited.length > 0) {
      L.push(`- **Evidence Cited**: ${review.evidenceCited.join(', ')}`);
    }
    if (review.error) L.push(`- **Error**: ${review.error}`);
    if (review.reasoning) {
      L.push('- **Reasoning**:');
      L.push(review.reasoning);
    }
    L.push('');
  }

  private renderCandidates(
    L: string[],
    candidates: ProductResolutionCandidateRecord[],
    live: Map<string, ProductModel>,
  ): void {
    L.push(`## Candidates Considered (${candidates.length})`);
    if (candidates.length === 0) {
      L.push('- (none — recall returned nothing)');
      L.push('');
      return;
    }

    candidates.forEach((candidate, index) => {
      const name = [candidate.brand, candidate.model].filter(Boolean).join(' ');
      const label = candidate.displayName || name || candidate.candidateId;
      L.push(`### c${index + 1}: ${label}`);
      L.push(`- **Candidate ID**: ${candidate.candidateId}`);
      L.push(`- **Recall Source**: ${candidate.source}`);
      L.push(`- **Match Score**: ${candidate.matchScore ?? '(not scored)'}`);
      L.push(
        `- **Gates**: ${candidate.gates?.passed ? 'passed' : 'FAILED'}${
          candidate.gates?.failedGates?.length
            ? ` — ${candidate.gates.failedGates.join(', ')}`
            : ''
        }`,
      );
      if (candidate.filtered) {
        L.push(
          `- **Filtered Out**: ${candidate.filtered.reason} — ${candidate.filtered.detail}`,
        );
      }
      if (candidate.matchComponents) {
        L.push('- **Match Components**:');
        for (const [key, value] of Object.entries(candidate.matchComponents)) {
          L.push(`  - ${key}: ${this.scalar(value)}`);
        }
      }

      const product = live.get(candidate.candidateId);
      if (product) {
        L.push('- **Live Product (as it is now)**:');
        this.renderProductLines(L, product, '  - ');
      } else {
        L.push(
          '- **Live Product**: (not found — merged away or deleted since this row was written)',
        );
      }

      this.renderSpecMatchDetails(
        L,
        '- **Spec Match**:',
        candidate.specMatchDetails,
        '  ',
      );
      L.push('');
    });
  }

  private renderSpecMatchDetails(
    L: string[],
    heading: string,
    details: SpecMatchDetails | undefined,
    indent = '',
  ): void {
    if (!details) {
      return;
    }

    L.push(heading);
    L.push(
      `${indent}- Comparable: ${details.comparableCount} · Matching: ${details.matchingCount} · Primary mismatches: ${details.primaryMismatches} · Matcher-spec mismatches: ${details.matcherSpecMismatches} · Non-primary mismatches: ${details.nonPrimaryMismatches}`,
    );
    for (const detail of details.details ?? []) {
      const flags = [
        detail.isPrimary ? 'primary' : null,
        detail.isMatcher ? 'matcher' : null,
      ].filter(Boolean);
      const flagSuffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      L.push(
        `${indent}- ${detail.key}${flagSuffix}: ${this.scalar(detail.valueA)} vs ${this.scalar(detail.valueB)} → ${detail.match}`,
      );
    }
  }

  private renderInputSnapshot(L: string[], r: ProductResolution): void {
    L.push('## Input Snapshot');
    const snapshot = r.inputSnapshot;
    if (!snapshot) {
      L.push('- (none)');
      L.push('');
      return;
    }

    L.push(`- **Kind**: ${snapshot.kind}`);
    if (snapshot.kind === 'product_resolution') {
      if (snapshot.callerSource) {
        L.push(`- **Caller Source**: ${snapshot.callerSource}`);
      }
      if (snapshot.brand) {
        L.push(
          `- **Inferred Brand**: ${snapshot.brand.name} (${snapshot.brand.id}) · similarity=${snapshot.brand.similarity}`,
        );
      }
      if (snapshot.category) {
        L.push(
          `- **Inferred Category**: ${snapshot.category.name} (${snapshot.category.id}) · similarity=${snapshot.category.similarity}`,
        );
      }
      if (snapshot.referenceProduct) {
        L.push(
          `- **Reference Product**: ${JSON.stringify(snapshot.referenceProduct)}`,
        );
      }
      if (snapshot.effectiveMatchSpecs) {
        L.push('- **Effective Match Specs**:');
        for (const [key, value] of Object.entries(
          snapshot.effectiveMatchSpecs,
        )) {
          L.push(`  - ${key}: ${this.scalar(value)}`);
        }
      }
      this.renderJsonBlock(L, '- **Input**:', snapshot.input);
      this.renderJsonBlock(L, '- **Options**:', snapshot.options);
    } else {
      L.push(`- **Trigram Score**: ${snapshot.trigramScore}`);
      if (snapshot.brandName) L.push(`- **Brand**: ${snapshot.brandName}`);
      if (snapshot.categorySlug) {
        L.push(`- **Category Slug**: ${snapshot.categorySlug}`);
      }
      this.renderJsonBlock(L, '- **Query Product**:', snapshot.query);
      this.renderJsonBlock(L, '- **Candidate Product**:', snapshot.candidate);
    }
    L.push('');
  }

  private renderDecisionSnapshot(L: string[], r: ProductResolution): void {
    const snapshot = r.decisionSnapshot;
    if (!snapshot) {
      return;
    }

    L.push('## Decision Snapshot (raw pipeline FinalDecision)');
    L.push(`- **Kind**: ${snapshot.kind}`);
    L.push(`- **Confidence**: ${snapshot.confidence}`);
    L.push(`- **Reason**: ${snapshot.reason}`);
    if (snapshot.evidenceSummary) {
      L.push(`- **Evidence Summary**: ${snapshot.evidenceSummary}`);
    }
    const selected = snapshot.selectedCandidates ?? [];
    if (selected.length > 0) {
      L.push(`- **Selected Candidates (${selected.length})**:`);
      for (const candidate of selected) {
        L.push(
          `  - ${candidate.candidateId} · confidence=${candidate.confidence}${
            candidate.reason ? ` · ${candidate.reason}` : ''
          }`,
        );
      }
    }
    L.push('');
  }

  private renderProductLines(
    L: string[],
    product: ProductModel,
    prefix: string,
  ): void {
    L.push(`${prefix}**ID**: ${product.id}`);
    L.push(`${prefix}**Display Name**: ${product.displayName}`);
    L.push(
      `${prefix}**Brand / Model**: ${product.brand?.name ?? '?'} / ${product.model}`,
    );
    L.push(
      `${prefix}**Category**: ${product.productCategory?.name ?? '(none)'}`,
    );
    L.push(`${prefix}**Slug**: ${product.slug ?? '(none)'}`);
    L.push(`${prefix}**Enabled**: ${product.enabled}`);
    const aliases = product.aliases ?? [];
    if (aliases.length > 0) {
      L.push(
        `${prefix}**Aliases (${aliases.length})**: ${aliases.map((a) => a.alias).join(' | ')}`,
      );
    }
    if (product.specs && Object.keys(product.specs).length > 0) {
      L.push(`${prefix}**Specs**: ${JSON.stringify(product.specs)}`);
    }
  }

  private renderJsonBlock(L: string[], heading: string, value: unknown): void {
    L.push(heading);
    L.push('```json');
    L.push(JSON.stringify(value, null, 2));
    L.push('```');
  }

  private ts(value: Date | string | null | undefined): string {
    if (!value) return '(none)';
    return value instanceof Date ? value.toISOString() : String(value);
  }

  private scalar(value: unknown): string {
    if (value === undefined || value === null) return '(none)';
    // Arrays of objects (e.g. priorityBreakdown.impactFactors) must not go
    // through join(), which stringifies each element to "[object Object]".
    if (Array.isArray(value)) {
      return value.some((item) => item !== null && typeof item === 'object')
        ? JSON.stringify(value)
        : value.join(', ');
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
}
