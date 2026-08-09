import type { ProductReference } from '../postgres/models/product-reference.entity';
import { Evidence, effectiveSentiment } from './comment-context';

/**
 * Read-side combiners that surface every label associated with a reference.
 *
 * Not stored — computed at read time. Used by DTO mappers, MCP renderers,
 * relevance scoring, and any other consumer that wants the full picture
 * (ref-level LLM emits + per-quote evidence) for one reference.
 *
 * Rules:
 *   - Ref-level evidence (`ref.features` / `ref.useCases`) is included as-is;
 *     it is always confirmed (the prompt forbids speculative ref-level emits).
 *   - Quote-level evidence is included only from non-speculative quotes;
 *     sentiment is resolved via `effectiveSentiment` (evidence.sentiment with
 *     quote.sentiment fallback).
 *   - Dedup by (label, resolved-sentiment). A label that genuinely appears
 *     with two different sentiments stays as two entries — downstream
 *     consolidation (see `label-consolidation.ts`) decides how to combine.
 *
 * Sentiment-aware split is the caller's responsibility (e.g. pros vs. cons).
 */
export function collectAllFeatures(
  ref: ProductReference,
): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const push = (entry: Evidence): void => {
    const key = `${entry.label}|${entry.sentiment ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  for (const evidence of ref.features ?? []) {
    push(evidence);
  }
  for (const quote of ref.quotes ?? []) {
    if (quote.speculative) continue;
    for (const evidence of quote.features ?? []) {
      push({
        label: evidence.label,
        sentiment: effectiveSentiment(evidence, quote),
      });
    }
  }
  return out;
}

export function collectAllUseCases(
  ref: ProductReference,
): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const push = (entry: Evidence): void => {
    const key = `${entry.label}|${entry.sentiment ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  for (const evidence of ref.useCases ?? []) {
    push({
      label: evidence.label,
      ...(evidence.sentiment != null && { sentiment: evidence.sentiment }),
    });
  }
  for (const quote of ref.quotes ?? []) {
    if (quote.speculative) continue;
    for (const evidence of quote.useCases ?? []) {
      push({
        label: evidence.label,
        sentiment: effectiveSentiment(evidence, quote),
      });
    }
  }
  return out;
}

/**
 * Issue evidence collector — quote-level only (no ref-level source).
 * Dedups by (label, sentiment) since issue entries always carry an explicit
 * negative sentiment (Negative or StrongNegative).
 */
export function collectAllIssues(
  ref: ProductReference,
): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const push = (entry: Evidence): void => {
    const key = `${entry.label}|${entry.sentiment ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  for (const quote of ref.quotes ?? []) {
    if (quote.speculative) continue;
    for (const evidence of quote.issues ?? []) {
      push({
        label: evidence.label,
        sentiment: evidence.sentiment,
      });
    }
  }
  return out;
}
