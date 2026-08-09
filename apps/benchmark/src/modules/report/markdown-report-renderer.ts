import { CandidateAggregate } from '../execution/candidate-aggregate.types';
import { CandidateScenarioAggregate, CostSummary, ParetoEntry } from '../cost/cost-analyzer.service';
import { Phase, Scenario } from '../scenario/scenario.types';
import { ReportPayload, SubtreeReportSection } from './report-writer.service';

export class MarkdownReportRenderer {
  render(payload: ReportPayload): string {
    const L: string[] = [];

    L.push(`# Benchmark report — ${payload.scenarioId}`);
    L.push('');
    L.push('## Run summary');
    L.push('');
    L.push(...this.renderRunSummaryTable(payload));
    L.push('');
    L.push('## Scenario parameters');
    L.push('');
    L.push(...this.renderScenarioParametersTable(payload));
    L.push('');
    L.push('## Scenario-level desired outcome (default)');
    L.push(payload.scenario.expectations.desiredOutcome);
    L.push('');

    L.push('---');
    L.push('');
    L.push('# Scenario-wide aggregates');
    L.push('');
    if (payload.seedSummary) {
      L.push('## Seed coverage (validation phase)');
      L.push('');
      L.push(...this.renderSeedSummaryTable(payload));
      L.push('');
    }
    L.push('## Pareto comparison (across all subtrees)');
    L.push('');
    L.push(...this.renderParetoTable(payload));
    L.push('');
    L.push('## Side-by-side metrics (rolled up across subtrees)');
    L.push('');
    L.push(...this.renderScenarioMetricsTable(payload));
    L.push('');
    L.push('## Cost summary');
    L.push(`- total: $${payload.costSummary.totalUsd.toFixed(6)}`);
    L.push(`- judge: $${payload.costSummary.judgeUsd.toFixed(6)}`);
    L.push(`- cost label glob: \`${payload.costSummary.byCostLabel}\``);
    L.push('');
    L.push(...this.renderCostBySubtreeTable(payload));
    L.push('');

    const multiInput = (payload.scenario.inputs?.length ?? 0) > 1;
    for (let i = 0; i < payload.subtrees.length; i++) {
      const section = payload.subtrees[i];
      const inputLabel = multiInput ? ` [input: ${section.inputId}]` : '';
      L.push('---');
      L.push('');
      L.push(`# Subtree ${i + 1}/${payload.subtrees.length}: \`${section.subtreeCase.label}\`${inputLabel}`);
      L.push('');
      L.push(...this.renderSubtreeSection(section, payload.scenario.phase));
      L.push('');
    }

    return L.join('\n');
  }

  // ─── Per-subtree section ────────────────────────────────────────────────────

  private renderSubtreeSection(section: SubtreeReportSection, phase: Phase): string[] {
    const L: string[] = [];

    L.push('## Desired outcome');
    L.push(section.subtreeCase.expectations.desiredOutcome);
    L.push('');

    L.push('## Input subtree');
    L.push(`- subtree id: \`${section.subtreeId}\` (${section.isOpSubtree ? 'OP subtree' : 'content subtree'})`);
    L.push(`- nodes: ${section.nodeCount} (PLAN: ${section.planNodeCount})`);
    L.push('');
    L.push('Rendered exactly as the LLM saw it (via `PromptAssemblyService.buildCommentsSection`):');
    L.push('');
    L.push('```');
    L.push(section.renderedSubtree);
    L.push('```');
    L.push('');

    if (section.resolvedProductsRendered && section.resolvedProductsRendered.length > 0) {
      L.push('## Resolved products (per PLAN comment)');
      L.push('');
      L.push('Rendered via `PromptAssemblyService.buildResolvedProductsSection`.');
      L.push('');
      L.push('```');
      L.push(section.resolvedProductsRendered);
      L.push('```');
      L.push('');
    }

    if (phase === 'validation') {
      L.push('## Validation findings (representative run per candidate)');
      L.push('');
      L.push(
        '_Validation output is per-ref, not per-comment — refs are labeled A, B, C... in DFS order across the subtree. Empty `issues` means silent approval (no issues emitted)._',
      );
      L.push('');
      L.push(...this.renderValidationFindings(section));
      L.push('');

      if (section.seedAnalysis) {
        L.push('## Seed coverage (this subtree)');
        L.push('');
        L.push(...this.renderSubtreeSeedCoverage(section));
        L.push('');
      }
    } else {
      L.push('## Per-comment outputs');
      L.push('');
      L.push(
        '_Each row is one PLAN comment. The first column carries the comment body (short id, author, depth, then verbatim body); each remaining column shows what one candidate extracted for that comment._',
      );
      L.push('');
      L.push(...this.renderPerCommentComparison(section, phase));
      L.push('');
    }

    L.push('## Per-subtree metrics');
    L.push('');
    L.push(...this.renderSubtreeMetricsTable(section));
    L.push('');

    if (section.judge) {
      L.push(`## Judge verdict (${section.subtreeCase.label})`);
      L.push(`**Verdict:** ${section.judge.verdict}`);
      L.push(`**Model:** ${section.judge.model}`);
      L.push('');
      L.push(...this.renderSideBySideJudgeTable(section));
      L.push('');
    }

    L.push('## Representative outputs');
    L.push('');
    L.push(...this.renderRepresentativeOutputs(section));

    return L;
  }

  // ─── Per-comment table ──────────────────────────────────────────────────────

  private renderPerCommentComparison(section: SubtreeReportSection, phase: Phase): string[] {
    const lines: string[] = [];
    if (section.planComments.length === 0) {
      return ['_No PLAN comments to compare._'];
    }

    const candidates = section.candidates;
    const header = ['comment', ...candidates.map((c) => `\`${c.candidateId}\``)];
    const separator = header.map(() => '---');
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${separator.join(' | ')} |`);

    for (const plan of section.planComments) {
      const authorLabel = plan.authorName ? ` @${plan.authorName}` : '';
      const meta = `\`${plan.shortId}\`${authorLabel} (d:${plan.depth})`;
      const rowHeader = `${meta}<br>${escapeCell(plan.body)}`;

      const outputCells = candidates.map((aggregate) =>
        this.buildPerRunCell(aggregate, plan.shortId, phase),
      );

      lines.push(`| ${[rowHeader, ...outputCells].join(' | ')} |`);
    }

    return lines;
  }

  private buildPerRunCell(aggregate: CandidateAggregate, shortId: string, phase: Phase): string {
    if (aggregate.runs.length === 0) return '_(no runs)_';
    const lines: string[] = [];
    for (const run of aggregate.runs) {
      const star = run.runIndex === aggregate.representativeRunIndex ? ' ★' : '';
      let outputFragment: string;
      if (!run.succeeded && run.failureReason && run.parsed === undefined) {
        outputFragment = `_(${run.failureReason}: ${escapeCell(run.failureMessage ?? '')})_`;
      } else {
        outputFragment = this.extractCommentOutput(run.parsed, shortId, phase);
      }
      lines.push(`run ${run.runIndex}${star}: ${outputFragment}`);
    }
    return lines.join('<br>');
  }

  private extractCommentOutput(parsed: unknown, shortId: string, phase: Phase): string {
    if (parsed === undefined || parsed === null) return '_(no parsed output)_';
    if (typeof parsed !== 'object') return '_(non-object output)_';

    if (phase === 'labeling') {
      const obj = parsed as { products?: unknown };
      if (!Array.isArray(obj.products)) {
        return `\`${escapeCell(JSON.stringify(parsed))}\``;
      }
      // Filter products[] by productId starting with the comment letter
      // (e.g. shortId="A" matches Aa, Ab, ...).
      const matching = (obj.products as Array<Record<string, unknown>>).filter(
        (entry) => typeof entry.productId === 'string' && (entry.productId as string).startsWith(shortId),
      );
      if (matching.length === 0) {
        return '_(no productIds for this comment)_';
      }
      return `\`${escapeCell(JSON.stringify(matching))}\``;
    }

    // Identification / extraction shape: { comments: [{ commentId, products }] }
    const obj = parsed as { comments?: unknown };
    if (!Array.isArray(obj.comments)) {
      return `\`${escapeCell(JSON.stringify(parsed))}\``;
    }
    const commentEntry = (obj.comments as Array<Record<string, unknown>>).find(
      (entry) => entry.commentId === shortId,
    );
    if (!commentEntry) return '_(not in response — treated as PLAN, conservative default)_';
    const products = commentEntry.products;
    if (!Array.isArray(products) || products.length === 0) {
      return '_(empty products — comment correctly demoted)_';
    }
    return `\`${escapeCell(JSON.stringify(products))}\``;
  }

  // ─── Per-subtree metrics table ──────────────────────────────────────────────

  private renderSubtreeMetricsTable(section: SubtreeReportSection): string[] {
    const candidates = section.candidates;
    if (candidates.length === 0) return ['_No candidates._'];

    const judgeScoreByCandidate = this.buildJudgeScoreLookup(section);
    const header = ['metric', ...candidates.map((c) => `\`${c.candidateId}\``)];
    const separator = header.map(() => '---');
    const rows: string[][] = [];

    rows.push(['model', ...candidates.map((c) => `\`${c.model}\``)]);
    rows.push(['success rate', ...candidates.map((c) => `${c.reliability.successes}/${c.reliability.totalRuns} (${Math.round(c.reliability.successRate * 100)}%)`)]);
    rows.push(['top failure', ...candidates.map((c) => this.topFailureFromAggregate(c) ?? '—')]);
    rows.push(['mustContain pass rate', ...candidates.map((c) => `${Math.round(c.deterministicChecks.aggregate.mustContainPassRate * 100)}%`)]);
    rows.push(['mustNotContain pass rate', ...candidates.map((c) => `${Math.round(c.deterministicChecks.aggregate.mustNotContainPassRate * 100)}%`)]);
    rows.push(['judge score (mean)', ...candidates.map((c) => { const s = judgeScoreByCandidate.get(c.candidateId); return s === undefined ? '—' : s.toFixed(2); })]);
    rows.push(['mean cost', ...candidates.map((c) => `$${c.cost.mean.toFixed(6)}`)]);
    rows.push(['relative cost (vs cheapest)', ...relativeCostCells(candidates.map((c) => c.cost.mean))]);
    rows.push(['cost min/max', ...candidates.map((c) => `$${c.cost.min.toFixed(6)} / $${c.cost.max.toFixed(6)}`)]);
    rows.push(['latency mean', ...candidates.map((c) => `${c.latency.meanSec.toFixed(2)}s`)]);
    rows.push(['prompt tokens (mean)', ...candidates.map((c) => `${Math.round(c.usage.meanPromptTokens)}`)]);
    rows.push(['completion tokens (mean)', ...candidates.map((c) => `${Math.round(c.usage.meanCompletionTokens)}`)]);

    const lines: string[] = [];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${separator.join(' | ')} |`);
    for (const row of rows) {
      lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
    }

    for (const c of candidates) {
      if (c.reliability.failures.total === 0) continue;
      lines.push('');
      lines.push(`**Failures for \`${c.candidateId}\`:**`);
      for (const detail of c.reliability.failures.detailsPerRun) {
        lines.push(`- run ${detail.runIndex}: ${detail.reason} — ${detail.message}`);
      }
    }

    return lines;
  }

  // ─── Per-subtree judge table ────────────────────────────────────────────────

  private renderSideBySideJudgeTable(section: SubtreeReportSection): string[] {
    const judge = section.judge;
    if (!judge) return [];

    const ordered = section.candidates.map((c) =>
      judge.candidates.find((j) => j.candidateId === c.candidateId),
    );

    const dimensions = new Set<string>();
    for (const judged of ordered) {
      if (!judged) continue;
      for (const key of Object.keys(judged.scores)) dimensions.add(key);
    }

    const lines: string[] = [];
    if (dimensions.size === 0) {
      lines.push('_Judge produced no per-candidate scores._');
    } else {
      const header = ['dimension', ...section.candidates.map((c) => `\`${c.candidateId}\``)];
      const separator = header.map(() => '---');
      lines.push(`| ${header.join(' | ')} |`);
      lines.push(`| ${separator.join(' | ')} |`);
      for (const dim of dimensions) {
        const row = [dim, ...ordered.map((judged) => {
          if (!judged) return '—';
          const value = judged.scores[dim];
          return typeof value === 'number' ? value.toString() : '—';
        })];
        lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
      }
      const meanRow = ['**mean**', ...ordered.map((judged) => {
        if (!judged) return '—';
        const values = Object.values(judged.scores).filter((v) => typeof v === 'number') as number[];
        if (values.length === 0) return '—';
        return `**${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)}**`;
      })];
      lines.push(`| ${meanRow.map(escapeCell).join(' | ')} |`);
    }

    lines.push('');
    lines.push('### Rationales');
    for (const judged of ordered) {
      if (!judged) continue;
      lines.push('');
      lines.push(`**\`${judged.candidateId}\`:** ${judged.rationale}`);
    }
    return lines;
  }

  // ─── Seed coverage (validation phase) ───────────────────────────────────────

  /**
   * Per-subtree table showing which seeded mistakes each candidate found vs
   * missed. One row per seed in this subtree, one column per candidate. The
   * per-cell `(X/N runs)` suffix shows how many runs of the candidate flagged
   * the seed; the representative ✅/❌ remains the primary signal.
   */
  private renderSubtreeSeedCoverage(section: SubtreeReportSection): string[] {
    const analysis = section.seedAnalysis!;
    if (analysis.expectedSeeds.length === 0) {
      return ['_No seeded mistakes in this subtree (every PLAN comment is correctly labeled — silent approval expected)._'];
    }
    const candidates = section.candidates;
    const lines: string[] = [];
    const header = ['comment', 'expected', 'refLabel', ...candidates.map((c) => `\`${c.candidateId}\``)];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    analysis.expectedSeeds.forEach((seed, i) => {
      const cells = candidates.map((c) => {
        const result = analysis.candidateResults[i].find((r) => r.candidateId === c.candidateId);
        if (!result) return '—';
        const runSuffix =
          result.runTotal > 1
            ? ` (${result.runFoundCount}/${result.runTotal} runs)`
            : '';
        if (result.found) return `✅ found${runSuffix}`;
        const emitted = result.emittedTypes.length > 0
          ? ` (emitted: ${result.emittedTypes.join(', ')})`
          : '';
        return `❌ missed${runSuffix}${emitted}`;
      });
      lines.push(
        `| \`${seed.commentExternalId}\` | \`${seed.expectedIssueType}\` | \`${seed.refLabel}\` | ${cells.join(' | ')} |`,
      );
    });
    return lines;
  }

  /**
   * Scenario-wide seed coverage table. One row per manifest entry; one column
   * per candidate. Surfaces a totals row at the bottom.
   */
  private renderSeedSummaryTable(payload: ReportPayload): string[] {
    const summary = payload.seedSummary!;
    const candidates = payload.candidatesAggregate;
    const lines: string[] = [];

    if (summary.rows.length === 0) {
      lines.push('_Seed manifest is empty._');
      return lines;
    }

    const header = ['comment', 'expected', 'subtree', 'refLabel', ...candidates.map((c) => `\`${c.candidateId}\``)];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const row of summary.rows) {
      const cells = candidates.map((c) => {
        const cell = row.byCandidate[c.candidateId];
        if (!cell) return '—';
        const mark = cell.repFound ? '✅' : '❌';
        const runSuffix =
          cell.runTotal > 1
            ? ` (${cell.runFoundCount}/${cell.runTotal})`
            : '';
        return `${mark}${runSuffix}`;
      });
      lines.push(
        `| \`${row.commentExternalId}\` | \`${row.expectedIssueType}\` | \`${row.subtreeLabel}\` | \`${row.refLabel}\` | ${cells.join(' | ')} |`,
      );
    }
    // Totals — representative-run row.
    const repTotalsCells = candidates.map((c) => {
      const t = summary.totals[c.candidateId];
      if (!t) return '—';
      const total = t.found + t.missed;
      return `**${t.found}/${total}**`;
    });
    lines.push(`| **totals (representative run)** | | | | ${repTotalsCells.join(' | ')} |`);
    // Totals — across all runs row (only render when there's actual cross-run signal).
    const hasMultiRun = candidates.some(
      (c) => (summary.totals[c.candidateId]?.runTotal ?? 0) > (summary.totals[c.candidateId]?.found ?? 0) + (summary.totals[c.candidateId]?.missed ?? 0),
    );
    if (hasMultiRun) {
      const runTotalsCells = candidates.map((c) => {
        const t = summary.totals[c.candidateId];
        if (!t || t.runTotal === 0) return '—';
        return `**${t.runFound}/${t.runTotal}**`;
      });
      lines.push(`| **totals (across all runs)** | | | | ${runTotalsCells.join(' | ')} |`);
    }

    if (summary.unmatchedSeedCount > 0) {
      lines.push('');
      lines.push(
        `⚠️ ${summary.unmatchedSeedCount} seed(s) could not be matched to any rendered subtree — check the fixture or manifest.`,
      );
    }
    return lines;
  }

  // ─── Validation findings ────────────────────────────────────────────────────

  /**
   * Renders the per-candidate validation `refs[]` from the representative run.
   * Each candidate gets a fenced block listing every emitted ref label and its
   * issues. Empty `refs[]` and empty `issues[]` are surfaced explicitly so a
   * silent-approval response is distinguishable from a missing one.
   */
  private renderValidationFindings(section: SubtreeReportSection): string[] {
    const lines: string[] = [];
    for (const aggregate of section.candidates) {
      const rep = aggregate.runs[aggregate.representativeRunIndex];
      lines.push(`### \`${aggregate.candidateId}\``);
      if (!rep) {
        lines.push('_No runs._');
        lines.push('');
        continue;
      }
      if (!rep.succeeded && rep.parsed === undefined) {
        lines.push(`_(${rep.failureReason ?? 'failure'}: ${rep.failureMessage ?? 'unknown'})_`);
        lines.push('');
        continue;
      }
      const refs = extractValidationRefs(rep.parsed);
      if (refs === null) {
        lines.push('_(parsed output is not a validation response)_');
        lines.push('');
        continue;
      }
      if (refs.length === 0) {
        lines.push('_(silent approval — no refs flagged)_');
        lines.push('');
        continue;
      }
      lines.push('```json');
      lines.push(JSON.stringify(refs, null, 2));
      lines.push('```');
      lines.push('');
    }
    return lines;
  }

  // ─── Representative outputs ─────────────────────────────────────────────────

  private renderRepresentativeOutputs(section: SubtreeReportSection): string[] {
    const lines: string[] = [];
    for (const aggregate of section.candidates) {
      const rep = aggregate.runs[aggregate.representativeRunIndex];
      lines.push(`### \`${aggregate.candidateId}\` (representative run, index=${aggregate.representativeRunIndex})`);
      if (!rep) {
        lines.push('_No runs._');
        lines.push('');
        continue;
      }
      lines.push('```json');
      lines.push(rep.parsed === undefined
        ? `(no parsed output — failure: ${rep.failureMessage ?? 'unknown'})`
        : JSON.stringify(rep.parsed, null, 2));
      lines.push('```');
      lines.push('');
    }
    return lines;
  }

  // ─── Scenario-wide tables ───────────────────────────────────────────────────

  private renderRunSummaryTable(payload: ReportPayload): string[] {
    const totalUsd = payload.costSummary.totalUsd;
    const judgeUsd = payload.costSummary.judgeUsd;
    const candidatesUsd = totalUsd - judgeUsd;

    const lines: string[] = [];
    lines.push('| field | value |');
    lines.push('| --- | --- |');
    lines.push(`| duration | ${formatDuration(payload.durationMs)} |`);
    lines.push(`| total cost | $${totalUsd.toFixed(6)} |`);
    lines.push(`| candidate calls | $${candidatesUsd.toFixed(6)} (${formatPercent(candidatesUsd, totalUsd)}) |`);
    lines.push(`| judge calls | $${judgeUsd.toFixed(6)} (${formatPercent(judgeUsd, totalUsd)}) |`);

    if (payload.candidatesAggregate.length > 0) {
      const perCandidate = payload.candidatesAggregate
        .map((c) => `\`${c.candidateId}\` $${c.cost.total.toFixed(6)} ($${c.cost.mean.toFixed(6)}/run, ${c.totalRuns} runs)`)
        .join('<br>');
      lines.push(`| per-candidate cost | ${perCandidate} |`);
    }

    return lines;
  }

  private renderScenarioParametersTable(payload: ReportPayload): string[] {
    const scenario = payload.scenario;
    const rows: Array<[string, string]> = [];

    rows.push(['id', `\`${scenario.id}\``]);
    rows.push(['phase', `\`${scenario.phase}\``]);
    rows.push(['description', scenario.description]);
    rows.push(['runs', `perCandidate=${scenario.runs.perCandidate}, concurrency=${scenario.runs.concurrency ?? 4}`]);

    rows.push(['input', this.summarizeInputSource(scenario)]);
    rows.push(['subtrees', `${payload.subtrees.length} (${payload.subtrees.map((s) => '`' + s.subtreeCase.label + '`').join(', ')})`]);

    const candidateSummaries = scenario.candidates.map((c) => {
      const promptSource = c.systemPromptSource === 'current' ? 'current' : `file: ${(c.systemPromptSource as { file: string }).file}`;
      return `\`${c.id}\` → ${c.model} (systemPrompt: ${promptSource})`;
    });
    rows.push(['candidates', candidateSummaries.join('<br>')]);

    if (scenario.judge) {
      const judgeBits = [
        `enabled=${scenario.judge.enabled}`,
        `model=${scenario.judge.model}`,
        `perRun=${scenario.judge.perRun ?? false}`,
      ];
      if (scenario.judge.goldenOutput) {
        judgeBits.push(`goldenOutput=\`${scenario.judge.goldenOutput.path}\` (role=${scenario.judge.goldenOutput.role})`);
      }
      rows.push(['judge', judgeBits.join(', ')]);
    } else {
      rows.push(['judge', '_not configured_']);
    }

    const lines: string[] = [];
    lines.push('| field | value |');
    lines.push('| --- | --- |');
    for (const [field, value] of rows) {
      lines.push(`| ${escapeCell(field)} | ${escapeCell(value)} |`);
    }
    return lines;
  }

  private summarizeInputSource(scenario: Scenario): string {
    const inputs = scenario.inputs && scenario.inputs.length > 0
      ? scenario.inputs
      : scenario.input ? [{ id: 'default', ...scenario.input }] : [];
    return inputs.map((entry) => {
      const prefix = inputs.length > 1 ? `[${entry.id}] ` : '';
      if (entry.kind === 'real-thread') {
        const sel = entry.subtrees === 'all' ? "subtrees='all'"
          : Array.isArray(entry.subtrees) ? `subtrees=[${entry.subtrees.map((s) => s.index).join(', ')}]`
          : entry.subtreeIndex !== undefined ? `subtreeIndex=${entry.subtreeIndex} (legacy)` : 'subtrees=<unspecified>';
        return `${prefix}real-thread: \`${entry.threadId}\`, mode=\`${entry.mode}\`, ${sel}`;
      }
      if (entry.kind === 'fixture') {
        const sel = entry.subtrees === 'all' ? ", subtrees='all'"
          : Array.isArray(entry.subtrees) ? `, subtrees=[${entry.subtrees.map((s) => s.index).join(', ')}]` : '';
        return `${prefix}fixture: \`${entry.path}\`${sel}`;
      }
      return JSON.stringify(entry);
    }).join('<br>');
  }

  private renderParetoTable(payload: ReportPayload): string[] {
    const lines: string[] = [];
    lines.push('| candidate | judge score (mean) | success rate | top failure | mustContain rate | mean cost | dominated by |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const entry of payload.pareto) {
      const judgeScore = entry.judgeScore === null ? '—' : entry.judgeScore.toFixed(2);
      const dominated = entry.paretoOptimal ? '— *(Pareto-optimal)*' : `\`${entry.dominatedBy ?? '—'}\``;
      lines.push(`| \`${entry.candidateId}\` | ${judgeScore} | ${Math.round(entry.successRate * 100)}% | ${entry.topFailureReason ?? '—'} | ${Math.round(entry.mustContainPassRate * 100)}% | $${entry.meanCost.toFixed(6)} | ${dominated} |`);
    }
    return lines;
  }

  private renderScenarioMetricsTable(payload: ReportPayload): string[] {
    const cands = payload.candidatesAggregate;
    if (cands.length === 0) return ['_No candidates._'];

    const header = ['metric', ...cands.map((c) => `\`${c.candidateId}\``)];
    const separator = header.map(() => '---');
    const rows: string[][] = [];

    rows.push(['model', ...cands.map((c) => `\`${c.model}\``)]);
    rows.push(['success rate (across subtrees)', ...cands.map((c) => `${c.successes}/${c.totalRuns} (${Math.round(c.successRate * 100)}%)`)]);
    rows.push(['top failure', ...cands.map((c) => this.topFailureFromObj(c.failuresByReason) ?? '—')]);
    rows.push(['mustContain pass rate (weighted)', ...cands.map((c) => `${Math.round(c.mustContainPassRate * 100)}%`)]);
    rows.push(['mustNotContain pass rate (weighted)', ...cands.map((c) => `${Math.round(c.mustNotContainPassRate * 100)}%`)]);
    rows.push(['judge score (mean of subtree means)', ...cands.map((c) => c.judgeScore === null ? '—' : c.judgeScore.toFixed(2))]);
    rows.push(['mean cost (per run)', ...cands.map((c) => `$${c.cost.mean.toFixed(6)}`)]);
    rows.push(['relative cost per run (vs cheapest)', ...relativeCostCells(cands.map((c) => c.cost.mean))]);
    rows.push(['total cost', ...cands.map((c) => `$${c.cost.total.toFixed(6)}`)]);
    rows.push(['relative total cost (vs cheapest)', ...relativeCostCells(cands.map((c) => c.cost.total))]);
    rows.push(['cost p95 (per run)', ...cands.map((c) => `$${c.cost.p95.toFixed(6)}`)]);
    rows.push(['latency mean', ...cands.map((c) => `${c.latencyMeanSec.toFixed(2)}s`)]);
    rows.push(['pareto-optimal', ...cands.map((c) => {
      const entry = payload.pareto.find((p) => p.candidateId === c.candidateId);
      if (!entry) return '—';
      return entry.paretoOptimal ? 'yes' : `no (dominated by \`${entry.dominatedBy}\`)`;
    })]);

    const lines: string[] = [];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${separator.join(' | ')} |`);
    for (const row of rows) {
      lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
    }
    return lines;
  }

  private renderCostBySubtreeTable(payload: ReportPayload): string[] {
    const subtreeLabels = Object.keys(payload.costSummary.bySubtree);
    if (subtreeLabels.length === 0) return [];
    const candidateIds = payload.candidatesAggregate.map((c) => c.candidateId);
    const header = ['subtree', ...candidateIds.map((id) => `\`${id}\``), 'subtotal'];
    const separator = header.map(() => '---');

    const lines: string[] = [];
    lines.push('### Cost by subtree');
    lines.push('');
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${separator.join(' | ')} |`);
    for (const label of subtreeLabels) {
      const stats = payload.costSummary.bySubtree[label];
      const cells = candidateIds.map((id) => `$${(stats.byCandidate[id] ?? 0).toFixed(6)}`);
      lines.push(`| \`${label}\` | ${cells.join(' | ')} | $${stats.totalUsd.toFixed(6)} |`);
    }
    return lines;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private buildJudgeScoreLookup(section: SubtreeReportSection): Map<string, number> {
    const map = new Map<string, number>();
    if (!section.judge) return map;
    for (const judged of section.judge.candidates) {
      const values = Object.values(judged.scores).filter((v) => typeof v === 'number') as number[];
      if (values.length === 0) continue;
      map.set(judged.candidateId, values.reduce((a, b) => a + b, 0) / values.length);
    }
    return map;
  }

  private topFailureFromAggregate(aggregate: CandidateAggregate): string | null {
    return this.topFailureFromObj(aggregate.reliability.failures.byReason);
  }

  private topFailureFromObj(byReason: { [k: string]: number }): string | null {
    const entries = Object.entries(byReason).filter(([, count]) => count > 0).sort(([, a], [, b]) => b - a);
    if (entries.length === 0) return null;
    return `${entries[0][0]} (${entries[0][1]})`;
  }
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, '0')}s`;
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((value / total) * 100)}%`;
}

function relativeCostCells(values: number[]): string[] {
  const positives = values.filter((v) => v > 0);
  if (positives.length === 0) return values.map(() => '—');
  const cheapest = Math.min(...positives);
  const tieAnnotation = positives.filter((v) => v === cheapest).length > 1 ? '1.00× *(tied cheapest)*' : '1.00× *(cheapest)*';
  return values.map((v) => {
    if (v === 0) return '—';
    if (v === cheapest) return tieAnnotation;
    const ratio = v / cheapest;
    return `${ratio.toFixed(2)}× (+${((ratio - 1) * 100).toFixed(0)}%)`;
  });
}

/**
 * Extract the `refs[]` array from a validation response. Returns:
 *   - the array (possibly empty — silent approval)
 *   - `null` if the parsed payload doesn't have the validation shape
 */
export function extractValidationRefs(parsed: unknown): unknown[] | null {
  if (parsed === undefined || parsed === null) return null;
  if (typeof parsed !== 'object') return null;
  const obj = parsed as { refs?: unknown };
  if (!Array.isArray(obj.refs)) return null;
  return obj.refs;
}
