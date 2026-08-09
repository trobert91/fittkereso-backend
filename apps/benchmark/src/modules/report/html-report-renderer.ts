import { CandidateAggregate } from '../execution/candidate-aggregate.types';
import { Phase } from '../scenario/scenario.types';
import { ReportPayload, SubtreeReportSection } from './report-writer.service';

/**
 * Renders a self-contained single-file HTML report. All CSS and JS are inlined.
 *
 * Layout per subtree:
 *   - Input subtree (collapsible code block)
 *   - For each PLAN comment:
 *       comment body (input)
 *       ── divider ──
 *       candidate-A output (run 0, run 1, representative flagged)
 *       ── divider ──
 *       candidate-B output
 *       ...
 *   - Judge verdict card
 *   - Metrics table
 *   - Representative full outputs (collapsible)
 */
export class HtmlReportRenderer {
  render(payload: ReportPayload): string {
    const candidateIds = payload.candidatesAggregate.map((c) => c.candidateId);
    const multiInput = (payload.scenario.inputs?.length ?? 0) > 1;

    const subtreeSections = payload.subtrees
      .map((section, i) => this.renderSubtreeSection(section, i, payload.subtrees.length, multiInput, payload.scenario.phase))
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Benchmark: ${h(payload.scenarioId)}</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="container">

<h1>Benchmark — <code>${h(payload.scenarioId)}</code></h1>

${this.renderSummaryCards(payload)}

<section class="scenario-wide">
<h2>Scenario-wide results</h2>
${payload.seedSummary ? this.renderSeedSummaryTable(payload) : ''}
${this.renderParetoCards(payload)}
${this.renderScenarioMetricsTable(payload, candidateIds)}
${this.renderCostBySubtreeTable(payload, candidateIds)}
</section>

<section class="subtrees">
${subtreeSections}
</section>

</div>
<script>
${JS}
</script>
</body>
</html>`;
  }

  // ─── Summary cards ──────────────────────────────────────────────────────────

  private renderSummaryCards(payload: ReportPayload): string {
    const total = payload.costSummary.totalUsd;
    const judge = payload.costSummary.judgeUsd;
    const candidates = total - judge;
    return `<div class="summary-cards">
  <div class="card"><div class="card-label">Duration</div><div class="card-value">${h(formatDuration(payload.durationMs))}</div></div>
  <div class="card"><div class="card-label">Total cost</div><div class="card-value">$${total.toFixed(4)}</div></div>
  <div class="card"><div class="card-label">Candidate calls</div><div class="card-value">$${candidates.toFixed(4)}</div></div>
  <div class="card"><div class="card-label">Judge calls</div><div class="card-value">$${judge.toFixed(4)}</div></div>
  <div class="card"><div class="card-label">Subtrees</div><div class="card-value">${payload.subtrees.length}</div></div>
  <div class="card"><div class="card-label">Candidates</div><div class="card-value">${payload.candidatesAggregate.length}</div></div>
</div>`;
  }

  // ─── Pareto cards ───────────────────────────────────────────────────────────

  private renderParetoCards(payload: ReportPayload): string {
    const cards = payload.pareto.map((entry) => {
      const scoreDisplay = entry.judgeScore === null ? '—' : entry.judgeScore.toFixed(2);
      const statusClass = entry.paretoOptimal ? 'pareto-optimal' : 'pareto-dominated';
      const statusLabel = entry.paretoOptimal
        ? '★ Pareto-optimal'
        : `dominated by ${entry.dominatedBy ?? '?'}`;
      return `<div class="pareto-card ${statusClass}">
  <div class="pareto-id"><code>${h(entry.candidateId)}</code></div>
  <div class="pareto-score">${h(scoreDisplay)}<span class="pareto-score-label"> judge</span></div>
  <div class="pareto-meta">
    <span>${Math.round(entry.successRate * 100)}% success</span>
    <span>$${entry.meanCost.toFixed(5)}/run</span>
  </div>
  <div class="pareto-status">${h(statusLabel)}</div>
</div>`;
    });
    return `<div class="pareto-cards">${cards.join('\n')}</div>`;
  }

  // ─── Scenario metrics table ─────────────────────────────────────────────────

  private renderScenarioMetricsTable(payload: ReportPayload, candidateIds: string[]): string {
    const cands = payload.candidatesAggregate;
    if (cands.length === 0) return '';

    const metricRows: Array<[string, string[]]> = [
      ['Model', cands.map((c) => `<code>${h(c.model)}</code>`)],
      ['Success rate', cands.map((c) => `${c.successes}/${c.totalRuns} (${Math.round(c.successRate * 100)}%)`)],
      ['Judge score (mean)', cands.map((c) => c.judgeScore === null ? '—' : `<strong>${c.judgeScore.toFixed(2)}</strong>`)],
      ['Mean cost / run', cands.map((c) => `$${c.cost.mean.toFixed(6)}`)],
      ['Total cost', cands.map((c) => `$${c.cost.total.toFixed(6)}`)],
      ['Latency mean', cands.map((c) => `${c.latencyMeanSec.toFixed(2)}s`)],
      ['mustContain pass', cands.map((c) => `${Math.round(c.mustContainPassRate * 100)}%`)],
    ];

    const header = `<tr><th>Metric</th>${candidateIds.map((id) => `<th><code>${h(id)}</code></th>`).join('')}</tr>`;
    const rows = metricRows.map(([label, cells]) =>
      `<tr><td class="metric-label">${h(label)}</td>${cells.map((v) => `<td>${v}</td>`).join('')}</tr>`
    ).join('\n');

    return `<details open><summary class="section-summary">Scenario metrics</summary>
<div class="table-wrap"><table class="metrics-table">
<thead>${header}</thead>
<tbody>${rows}</tbody>
</table></div></details>`;
  }

  // ─── Cost by subtree table ──────────────────────────────────────────────────

  private renderCostBySubtreeTable(payload: ReportPayload, candidateIds: string[]): string {
    const subtreeLabels = Object.keys(payload.costSummary.bySubtree);
    if (subtreeLabels.length === 0) return '';

    const header = `<tr><th>Subtree</th>${candidateIds.map((id) => `<th><code>${h(id)}</code></th>`).join('')}<th>Subtotal</th></tr>`;
    const rows = subtreeLabels.map((label) => {
      const stats = payload.costSummary.bySubtree[label];
      const cells = candidateIds.map((id) => `<td>$${(stats.byCandidate[id] ?? 0).toFixed(5)}</td>`).join('');
      return `<tr><td><code>${h(label)}</code></td>${cells}<td>$${stats.totalUsd.toFixed(5)}</td></tr>`;
    }).join('\n');

    return `<details><summary class="section-summary">Cost by subtree</summary>
<div class="table-wrap"><table class="metrics-table">
<thead>${header}</thead>
<tbody>${rows}</tbody>
</table></div></details>`;
  }

  // ─── Per-subtree section ────────────────────────────────────────────────────

  private renderSubtreeSection(
    section: SubtreeReportSection,
    index: number,
    total: number,
    multiInput: boolean,
    phase: Phase,
  ): string {
    const inputLabel = multiInput ? ` <span class="input-tag">${h(section.inputId)}</span>` : '';
    const verdictBadge = section.judge ? this.verdictBadge(section.judge.verdict) : '';

    return `<section class="subtree-section">
<h2 class="subtree-heading">
  Subtree ${index + 1}/${total}: <code>${h(section.subtreeCase.label)}</code>${inputLabel}
  ${verdictBadge}
</h2>

${this.renderSubtreeInfo(section)}
${this.renderInputBlock(section)}
${section.resolvedProductsRendered ? this.renderResolvedProducts(section) : ''}
${phase === 'validation' ? this.renderValidationFindings(section) : this.renderPerCommentOutputs(section, phase)}
${phase === 'validation' && section.seedAnalysis ? this.renderSubtreeSeedCoverage(section) : ''}
${section.judge ? this.renderJudgeVerdict(section) : ''}
${this.renderSubtreeMetrics(section)}
${this.renderRepresentativeOutputs(section)}
</section>`;
  }

  private verdictBadge(verdict: string): string {
    const cls = verdict.startsWith('best=') ? 'badge-best'
      : verdict === 'tie' ? 'badge-tie'
      : 'badge-none';
    const label = verdict.startsWith('best=') ? `✓ ${verdict.replace('best=', '')}` : verdict;
    return `<span class="verdict-badge ${cls}">${h(label)}</span>`;
  }

  private renderSubtreeInfo(section: SubtreeReportSection): string {
    return `<div class="subtree-meta">
  <span><strong>ID:</strong> <code>${h(section.subtreeId)}</code></span>
  <span><strong>Type:</strong> ${section.isOpSubtree ? 'OP subtree' : 'content subtree'}</span>
  <span><strong>Nodes:</strong> ${section.nodeCount} (PLAN: ${section.planNodeCount})</span>
</div>`;
  }

  private renderInputBlock(section: SubtreeReportSection): string {
    return `<details class="input-block"><summary class="section-summary">Input subtree (rendered exactly as the LLM saw it)</summary>
<pre class="code-block">${h(section.renderedSubtree)}</pre>
</details>`;
  }

  private renderResolvedProducts(section: SubtreeReportSection): string {
    return `<details class="input-block"><summary class="section-summary">Resolved products (per PLAN comment)</summary>
<pre class="code-block">${h(section.resolvedProductsRendered ?? '')}</pre>
</details>`;
  }

  // ─── Per-comment outputs ────────────────────────────────────────────────────

  private renderPerCommentOutputs(section: SubtreeReportSection, phase: Phase): string {
    if (section.planComments.length === 0) return '<p><em>No PLAN comments.</em></p>';

    const blocks = section.planComments.map((plan) => {
      const authorLabel = plan.authorName ? ` <span class="author">@${h(plan.authorName)}</span>` : '';
      const commentHeader = `<div class="comment-id"><code>${h(plan.shortId)}</code>${authorLabel} <span class="depth">d:${plan.depth}</span></div>`;
      const commentBody = `<div class="comment-body">${h(plan.body)}</div>`;

      const candidateOutputs = section.candidates.map((aggregate) => {
        const outputs = this.buildCandidateOutputBlocks(aggregate, plan.shortId, phase);
        return `<div class="candidate-output">
  <div class="candidate-label"><code>${h(aggregate.candidateId)}</code></div>
  ${outputs}
</div>`;
      }).join('<hr class="output-divider">');

      return `<div class="comment-block">
  <div class="comment-input">
    ${commentHeader}
    ${commentBody}
  </div>
  <div class="candidate-outputs">
    ${candidateOutputs}
  </div>
</div>`;
    }).join('\n');

    return `<div class="per-comment-section">
<h3 class="subsection-heading">Per-comment outputs</h3>
${blocks}
</div>`;
  }

  private buildCandidateOutputBlocks(aggregate: CandidateAggregate, shortId: string, phase: Phase): string {
    if (aggregate.runs.length === 0) return '<em>No runs.</em>';
    return aggregate.runs.map((run) => {
      const isRep = run.runIndex === aggregate.representativeRunIndex;
      const repBadge = isRep ? ' <span class="rep-badge">★ representative</span>' : '';
      const runLabel = `<span class="run-label">run ${run.runIndex}${repBadge}</span>`;

      let content: string;
      if (!run.succeeded && run.failureReason && run.parsed === undefined) {
        content = `<span class="failure-text">${h(run.failureReason)}: ${h(run.failureMessage ?? '')}</span>`;
      } else {
        const extracted = this.extractCommentProducts(run.parsed, shortId, phase);
        content = extracted === null
          ? '<em class="empty-products">products: []</em>'
          : `<pre class="json-output">${h(JSON.stringify(extracted, null, 2))}</pre>`;
      }

      return `<div class="run-block${isRep ? ' run-rep' : ''}">${runLabel}${content}</div>`;
    }).join('');
  }

  private extractCommentProducts(parsed: unknown, shortId: string, phase: Phase): unknown[] | null {
    if (parsed === undefined || parsed === null) return null;
    if (typeof parsed !== 'object') return null;

    if (phase === 'labeling') {
      // Labeling shape: { products: [{ productId: "Aa" | "Ab" | ..., quotes: [...] }] }.
      // Filter to the productIds that belong to this comment letter.
      const obj = parsed as { products?: unknown };
      if (!Array.isArray(obj.products)) return null;
      const matching = (obj.products as Array<Record<string, unknown>>).filter(
        (entry) => typeof entry.productId === 'string' && (entry.productId as string).startsWith(shortId),
      );
      if (matching.length === 0) return null;
      return matching;
    }

    // Identification / extraction shape: { comments: [{ commentId, products }] }.
    const obj = parsed as { comments?: unknown };
    if (!Array.isArray(obj.comments)) return null;
    const commentEntry = (obj.comments as Array<Record<string, unknown>>).find(
      (entry) => entry.commentId === shortId,
    );
    if (!commentEntry) return null;
    const products = commentEntry.products;
    if (!Array.isArray(products) || products.length === 0) return null;
    return products;
  }

  // ─── Judge verdict ──────────────────────────────────────────────────────────

  private renderJudgeVerdict(section: SubtreeReportSection): string {
    const judge = section.judge!;
    const ordered = section.candidates.map((c) =>
      judge.candidates.find((j) => j.candidateId === c.candidateId),
    );

    const dimensions = [...new Set(ordered.flatMap((j) => j ? Object.keys(j.scores) : []))];

    const headerCells = `<th>Dimension</th>${section.candidates.map((c) => `<th><code>${h(c.candidateId)}</code></th>`).join('')}`;
    const scoreRows = dimensions.map((dim) => {
      const cells = ordered.map((judged) => {
        if (!judged) return '<td>—</td>';
        const value = judged.scores[dim];
        return `<td>${typeof value === 'number' ? value : '—'}</td>`;
      }).join('');
      return `<tr><td class="metric-label">${h(dim)}</td>${cells}</tr>`;
    }).join('\n');

    const meanRow = ordered.map((judged) => {
      if (!judged) return '<td>—</td>';
      const values = Object.values(judged.scores).filter((v) => typeof v === 'number') as number[];
      if (values.length === 0) return '<td>—</td>';
      return `<td><strong>${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)}</strong></td>`;
    }).join('');

    const rationaleCards = ordered.filter(Boolean).map((judged) => `
<div class="rationale-card">
  <div class="rationale-candidate"><code>${h(judged!.candidateId)}</code></div>
  <div class="rationale-text">${h(judged!.rationale)}</div>
</div>`).join('');

    return `<details open class="judge-section"><summary class="section-summary">Judge verdict — <strong>${h(judge.verdict)}</strong> <span class="judge-model">(${h(judge.model)})</span></summary>
<div class="table-wrap"><table class="metrics-table judge-table">
<thead><tr>${headerCells}</tr></thead>
<tbody>
${scoreRows}
<tr class="mean-row"><td class="metric-label"><strong>Mean</strong></td>${meanRow}</tr>
</tbody>
</table></div>
<div class="rationale-cards">${rationaleCards}</div>
</details>`;
  }

  // ─── Subtree metrics ────────────────────────────────────────────────────────

  private renderSubtreeMetrics(section: SubtreeReportSection): string {
    const cands = section.candidates;
    if (cands.length === 0) return '';

    const judgeScores = this.buildJudgeScoreLookup(section);
    const metricRows: Array<[string, string[]]> = [
      ['Model', cands.map((c) => `<code>${h(c.model)}</code>`)],
      ['Success rate', cands.map((c) => `${c.reliability.successes}/${c.reliability.totalRuns} (${Math.round(c.reliability.successRate * 100)}%)`)],
      ['Judge score', cands.map((c) => { const s = judgeScores.get(c.candidateId); return s === undefined ? '—' : `<strong>${s.toFixed(2)}</strong>`; })],
      ['Mean cost', cands.map((c) => `$${c.cost.mean.toFixed(6)}`)],
      ['Latency mean', cands.map((c) => `${c.latency.meanSec.toFixed(2)}s`)],
      ['Prompt tokens', cands.map((c) => `${Math.round(c.usage.meanPromptTokens)}`)],
      ['Completion tokens', cands.map((c) => `${Math.round(c.usage.meanCompletionTokens)}`)],
    ];

    const header = `<tr><th>Metric</th>${cands.map((c) => `<th><code>${h(c.candidateId)}</code></th>`).join('')}</tr>`;
    const rows = metricRows.map(([label, cells]) =>
      `<tr><td class="metric-label">${h(label)}</td>${cells.map((v) => `<td>${v}</td>`).join('')}</tr>`
    ).join('\n');

    return `<details><summary class="section-summary">Subtree metrics</summary>
<div class="table-wrap"><table class="metrics-table">
<thead>${header}</thead>
<tbody>${rows}</tbody>
</table></div></details>`;
  }

  // ─── Seed coverage (validation phase) ───────────────────────────────────────

  /**
   * Per-subtree HTML table showing which seeded mistakes each candidate found
   * vs missed. Mirrors the markdown renderer's logic.
   */
  private renderSubtreeSeedCoverage(section: SubtreeReportSection): string {
    const analysis = section.seedAnalysis;
    if (!analysis) return '';
    if (analysis.expectedSeeds.length === 0) {
      return `<section class="seed-coverage">
<h3 class="subsection-heading">Seed coverage (this subtree)</h3>
<p class="section-note"><em>No seeded mistakes in this subtree (every PLAN comment is correctly labeled — silent approval expected).</em></p>
</section>`;
    }
    const candidates = section.candidates;
    const headerCells = ['comment', 'expected', 'refLabel', ...candidates.map((c) => `<code>${h(c.candidateId)}</code>`)];
    const rows = analysis.expectedSeeds.map((seed, i) => {
      const cells = candidates.map((c) => {
        const result = analysis.candidateResults[i].find((r) => r.candidateId === c.candidateId);
        if (!result) return '<td class="seed-cell">—</td>';
        const runSuffix =
          result.runTotal > 1
            ? ` <span class="seed-runcount">(${result.runFoundCount}/${result.runTotal} runs)</span>`
            : '';
        if (result.found) return `<td class="seed-cell seed-found">✅ found${runSuffix}</td>`;
        const emitted = result.emittedTypes.length > 0
          ? ` <span class="seed-emitted">(${h(result.emittedTypes.join(', '))})</span>`
          : '';
        return `<td class="seed-cell seed-missed">❌ missed${runSuffix}${emitted}</td>`;
      });
      return `<tr>
  <td><code>${h(seed.commentExternalId)}</code></td>
  <td><code>${h(seed.expectedIssueType)}</code></td>
  <td><code>${h(seed.refLabel)}</code></td>
  ${cells.join('\n  ')}
</tr>`;
    }).join('\n');
    return `<section class="seed-coverage">
<h3 class="subsection-heading">Seed coverage (this subtree)</h3>
<table class="metrics-table">
<thead><tr>${headerCells.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
<tbody>${rows}</tbody>
</table>
</section>`;
  }

  /**
   * Scenario-wide HTML seed coverage table — one row per manifest entry, plus
   * a totals row with found/total per candidate.
   */
  private renderSeedSummaryTable(payload: ReportPayload): string {
    const summary = payload.seedSummary;
    if (!summary) return '';
    const candidates = payload.candidatesAggregate;
    if (summary.rows.length === 0) {
      return '<p class="section-note"><em>Seed manifest is empty.</em></p>';
    }
    const headerCells = ['comment', 'expected', 'subtree', 'refLabel', ...candidates.map((c) => `<code>${h(c.candidateId)}</code>`)];
    const rows = summary.rows.map((row) => {
      const cells = candidates.map((c) => {
        const cell = row.byCandidate[c.candidateId];
        if (!cell) return '<td class="seed-cell">—</td>';
        const runSuffix =
          cell.runTotal > 1
            ? ` <span class="seed-runcount">(${cell.runFoundCount}/${cell.runTotal})</span>`
            : '';
        return cell.repFound
          ? `<td class="seed-cell seed-found">✅${runSuffix}</td>`
          : `<td class="seed-cell seed-missed">❌${runSuffix}</td>`;
      });
      return `<tr>
  <td><code>${h(row.commentExternalId)}</code></td>
  <td><code>${h(row.expectedIssueType)}</code></td>
  <td><code>${h(row.subtreeLabel)}</code></td>
  <td><code>${h(row.refLabel)}</code></td>
  ${cells.join('\n  ')}
</tr>`;
    }).join('\n');
    const repTotalsCells = candidates.map((c) => {
      const t = summary.totals[c.candidateId];
      if (!t) return '<td>—</td>';
      const total = t.found + t.missed;
      return `<td class="seed-totals"><strong>${t.found}/${total}</strong></td>`;
    });
    const hasMultiRun = candidates.some((c) => {
      const t = summary.totals[c.candidateId];
      return t ? t.runTotal > t.found + t.missed : false;
    });
    const runTotalsRow = hasMultiRun
      ? `<tr><td colspan="4"><strong>totals (across all runs)</strong></td>${candidates
          .map((c) => {
            const t = summary.totals[c.candidateId];
            if (!t || t.runTotal === 0) return '<td>—</td>';
            return `<td class="seed-totals"><strong>${t.runFound}/${t.runTotal}</strong></td>`;
          })
          .join('')}</tr>`
      : '';
    const unmatched = summary.unmatchedSeedCount > 0
      ? `<p class="section-note">⚠️ ${summary.unmatchedSeedCount} seed(s) could not be matched to any rendered subtree — check the fixture or manifest.</p>`
      : '';
    return `<section class="seed-summary">
<h3 class="subsection-heading">Seed coverage (validation phase)</h3>
<table class="metrics-table">
<thead><tr>${headerCells.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
<tbody>${rows}
<tr class="seed-totals-row"><td colspan="4"><strong>totals (representative run)</strong></td>${repTotalsCells.join('')}</tr>
${runTotalsRow}
</tbody>
</table>
${unmatched}
</section>`;
  }

  // ─── Validation findings ────────────────────────────────────────────────────

  /**
   * Renders the validation `refs[]` from the representative run for each
   * candidate. Empty `refs[]` is surfaced as silent approval; an off-shape
   * payload is surfaced explicitly so silent failures can't hide.
   */
  private renderValidationFindings(section: SubtreeReportSection): string {
    const blocks = section.candidates.map((aggregate) => {
      const rep = aggregate.runs[aggregate.representativeRunIndex];
      let content: string;
      if (!rep) {
        content = '<em>No runs.</em>';
      } else if (!rep.succeeded && rep.parsed === undefined) {
        content = `<em class="failure-text">${h(rep.failureReason ?? 'failure')}: ${h(rep.failureMessage ?? 'unknown')}</em>`;
      } else {
        const refs = extractValidationRefsFromParsed(rep.parsed);
        if (refs === null) {
          content = '<em>Parsed output is not a validation response.</em>';
        } else if (refs.length === 0) {
          content = '<em class="empty-products">silent approval — no refs flagged</em>';
        } else {
          content = `<pre class="json-output">${h(JSON.stringify(refs, null, 2))}</pre>`;
        }
      }
      return `<div class="rep-output-block">
  <div class="candidate-label"><code>${h(aggregate.candidateId)}</code> <span class="rep-badge">run ${aggregate.representativeRunIndex}</span></div>
  ${content}
</div>`;
    }).join('');

    return `<section class="validation-findings">
<h3 class="subsection-heading">Validation findings (representative run per candidate)</h3>
<p class="section-note">Validation output is per-ref — refs are labeled A, B, C... in DFS order across the subtree. Empty <code>issues</code> means silent approval.</p>
<div class="rep-outputs">${blocks}</div>
</section>`;
  }

  // ─── Representative outputs ─────────────────────────────────────────────────

  private renderRepresentativeOutputs(section: SubtreeReportSection): string {
    const blocks = section.candidates.map((aggregate) => {
      const rep = aggregate.runs[aggregate.representativeRunIndex];
      const content = !rep
        ? '<em>No runs.</em>'
        : rep.parsed === undefined
          ? `<em>No parsed output — ${h(rep.failureMessage ?? 'unknown')}</em>`
          : `<pre class="json-output">${h(JSON.stringify(rep.parsed, null, 2))}</pre>`;
      return `<div class="rep-output-block">
  <div class="candidate-label"><code>${h(aggregate.candidateId)}</code> <span class="rep-badge">run ${aggregate.representativeRunIndex}</span></div>
  ${content}
</div>`;
    }).join('');

    return `<details><summary class="section-summary">Full representative outputs</summary>
<div class="rep-outputs">${blocks}</div>
</details>`;
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
}

/** Escape HTML special characters. */
function h(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, '0')}s`;
}

function extractValidationRefsFromParsed(parsed: unknown): unknown[] | null {
  if (parsed === undefined || parsed === null) return null;
  if (typeof parsed !== 'object') return null;
  const obj = parsed as { refs?: unknown };
  if (!Array.isArray(obj.refs)) return null;
  return obj.refs;
}

// ─── Inline CSS ───────────────────────────────────────────────────────────────

const CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; color: #1a1a1a; background: #f5f5f5; margin: 0; padding: 0; }
.container { max-width: 1400px; margin: 0 auto; padding: 24px; }

h1 { font-size: 1.6rem; margin: 0 0 20px; }
h2 { font-size: 1.2rem; margin: 24px 0 12px; }
h3.subsection-heading { font-size: 1rem; margin: 16px 0 10px; color: #444; }
code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.85em; background: #eee; padding: 1px 4px; border-radius: 3px; }

/* Summary cards */
.summary-cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 24px; }
.card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 18px; min-width: 120px; }
.card-label { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
.card-value { font-size: 1.3rem; font-weight: 600; margin-top: 2px; }

/* Pareto cards */
.pareto-cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0 20px; }
.pareto-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 18px; min-width: 160px; }
.pareto-card.pareto-optimal { border-color: #22c55e; background: #f0fdf4; }
.pareto-card.pareto-dominated { border-color: #e0e0e0; background: #fafafa; opacity: 0.85; }
.pareto-id { font-size: 0.85rem; margin-bottom: 4px; }
.pareto-score { font-size: 1.6rem; font-weight: 700; }
.pareto-score-label { font-size: 0.75rem; color: #666; font-weight: 400; }
.pareto-meta { font-size: 0.8rem; color: #555; display: flex; gap: 10px; margin: 4px 0; }
.pareto-status { font-size: 0.75rem; color: #22c55e; font-weight: 600; }
.pareto-dominated .pareto-status { color: #999; }

/* Verdict badge */
.verdict-badge { display: inline-block; font-size: 0.75rem; padding: 2px 8px; border-radius: 12px; font-weight: 600; margin-left: 8px; vertical-align: middle; }
.badge-best { background: #dcfce7; color: #166534; }
.badge-tie { background: #fef9c3; color: #854d0e; }
.badge-none { background: #fee2e2; color: #991b1b; }

/* Section summaries / details */
details { margin: 10px 0; }
summary { cursor: pointer; user-select: none; }
summary::-webkit-details-marker { display: none; }
summary::before { content: '▶ '; font-size: 0.8em; transition: transform 0.15s; display: inline-block; }
details[open] summary::before { content: '▼ '; }
.section-summary { font-size: 0.9rem; font-weight: 600; color: #333; padding: 6px 0; border-bottom: 1px solid #e8e8e8; margin-bottom: 8px; }

/* Tables */
.table-wrap { overflow-x: auto; }
.metrics-table { border-collapse: collapse; width: 100%; font-size: 0.85rem; background: #fff; }
.metrics-table th { background: #f0f0f0; font-weight: 600; text-align: left; padding: 7px 10px; border: 1px solid #ddd; white-space: nowrap; }
.metrics-table td { padding: 6px 10px; border: 1px solid #ddd; vertical-align: top; }
.metric-label { color: #555; white-space: nowrap; font-size: 0.82rem; }
.mean-row td { background: #f8f8f8; font-weight: 600; }

/* Subtree sections */
.subtree-section { background: #fff; border: 1px solid #e0e0e0; border-radius: 10px; padding: 20px; margin-bottom: 28px; }
.subtree-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 1.1rem; margin: 0 0 14px; border-bottom: 2px solid #f0f0f0; padding-bottom: 10px; }
.input-tag { font-size: 0.75rem; background: #e0f2fe; color: #0369a1; padding: 2px 7px; border-radius: 10px; }
.subtree-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 0.82rem; color: #555; margin-bottom: 12px; }

/* Input block */
.input-block summary { color: #374151; }
.code-block { background: #1e1e1e; color: #d4d4d4; padding: 14px; border-radius: 6px; font-size: 0.82rem; font-family: 'JetBrains Mono', monospace; overflow-x: auto; white-space: pre; margin: 8px 0; line-height: 1.5; }

/* Per-comment outputs */
.per-comment-section { margin: 16px 0; }
.comment-block { border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
.comment-input { background: #f8fafc; padding: 12px 14px; border-bottom: 2px solid #e2e8f0; }
.comment-id { font-size: 0.82rem; margin-bottom: 4px; }
.author { color: #6366f1; }
.depth { color: #94a3b8; font-size: 0.78rem; }
.comment-body { font-size: 0.87rem; color: #334155; white-space: pre-wrap; word-break: break-word; }

.candidate-outputs { padding: 0; }
.candidate-output { padding: 10px 14px; }
hr.output-divider { margin: 0; border: none; border-top: 1px dashed #e2e8f0; }
.candidate-label { font-size: 0.8rem; font-weight: 600; margin-bottom: 6px; color: #475569; }
.run-block { margin-bottom: 6px; }
.run-block.run-rep { background: #fffbeb; border-left: 3px solid #f59e0b; padding-left: 6px; border-radius: 0 4px 4px 0; }
.run-label { font-size: 0.75rem; color: #64748b; display: block; margin-bottom: 3px; }
.rep-badge { background: #fef3c7; color: #92400e; font-size: 0.7rem; padding: 1px 5px; border-radius: 8px; font-weight: 600; }
.json-output { background: #f8f8f8; border: 1px solid #e8e8e8; border-radius: 4px; padding: 8px 10px; font-size: 0.8rem; font-family: 'JetBrains Mono', monospace; overflow-x: auto; white-space: pre; margin: 2px 0; color: #1e293b; }
.empty-products { color: #94a3b8; font-size: 0.82rem; }
.failure-text { color: #dc2626; font-size: 0.82rem; }

/* Judge section */
.judge-section { margin: 14px 0; }
.judge-section summary { color: #1d4ed8; }
.judge-model { font-weight: 400; color: #64748b; font-size: 0.82rem; }
.judge-table th, .judge-table td { text-align: center; }
.judge-table td:first-child { text-align: left; }
.rationale-cards { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.rationale-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px; }
.rationale-candidate { font-size: 0.82rem; font-weight: 600; margin-bottom: 4px; }
.rationale-text { font-size: 0.85rem; color: #334155; }

/* Representative outputs */
.rep-outputs { display: flex; flex-direction: column; gap: 12px; padding: 8px 0; }
.rep-output-block { border: 1px solid #e8e8e8; border-radius: 6px; overflow: hidden; }
.rep-output-block .candidate-label { background: #f0f0f0; padding: 7px 12px; font-size: 0.82rem; font-weight: 600; }

/* Scenario-wide section */
.scenario-wide { background: #fff; border: 1px solid #e0e0e0; border-radius: 10px; padding: 20px; margin-bottom: 28px; }

/* Seed coverage tables */
.seed-summary, .seed-coverage { margin: 12px 0 18px; }
.seed-cell { text-align: center; white-space: nowrap; }
.seed-found { color: #1a7f37; font-weight: 600; }
.seed-missed { color: #b13a3a; font-weight: 600; }
.seed-emitted { color: #7a7a7a; font-weight: 400; font-size: 0.85em; }
.seed-totals { text-align: center; }
.seed-totals-row td { background: #f5f5f5; }
`;

// ─── Inline JS ────────────────────────────────────────────────────────────────

const JS = `
// Nothing needed — <details> handles toggle natively.
// Reserved for future enhancements (search, filter, jump-to-subtree).
`;
