/**
 * What a scraping run stores on each list-page task it queues: when the run
 * began. A run's list pages are separate tasks, and this is what they share —
 * the run-wide `maxItems` cap counts the source's detail tasks created since.
 */
export interface ListPageTaskPayload {
  /** ISO timestamp. */
  runStartedAt: string;
}

export function listPageTaskPayload(runStartedAt: Date): ListPageTaskPayload {
  return { runStartedAt: runStartedAt.toISOString() };
}

/** The run's start, when the payload records one. */
export function runStartedAtOf(
  payload: Record<string, unknown> | null | undefined,
): Date | undefined {
  const value = payload?.['runStartedAt'];
  if (typeof value !== 'string') return undefined;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
