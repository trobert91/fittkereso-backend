import { Readable } from 'stream';

/** How long a body may send nothing while it is being read before the fetch is given up. */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000;

/** A response body that stopped arriving while it was being read. */
export class StreamStalledError extends Error {
  constructor(
    readonly url: string,
    readonly stallTimeoutMs: number,
  ) {
    super(
      `Fetching ${url} stalled: no data for ${Math.round(stallTimeoutMs / 1000)} s while reading the body`,
    );
    this.name = 'StreamStalledError';
  }
}

/**
 * The same body, failing with StreamStalledError when the source sends
 * nothing for `stallTimeoutMs` while the reader is waiting for it.
 *
 * Why: the HTTP client's timeout stops counting once the response headers
 * arrive, so a body that stops mid-download would hang its reader until the
 * task queue reclaims the task, hours later, with the socket still open.
 *
 * Only the time spent waiting for the source counts: the next chunk is asked
 * for when the reader wants one. A slow reader (an import pausing for its
 * batches) never looks like a stall, however long it takes.
 */
export function withStallGuard(source: Readable, stallTimeoutMs: number, url: string): Readable {
  const chunks = source[Symbol.asyncIterator]();

  return new Readable({
    async read() {
      let timer: NodeJS.Timeout | undefined;
      const next = chunks.next();
      // Settled after a stall too, when the source is destroyed: nobody awaits it then.
      next.catch(() => undefined);
      try {
        const result = await Promise.race([
          next,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StreamStalledError(url, stallTimeoutMs)), stallTimeoutMs);
          }),
        ]);
        if (result.done) this.push(null);
        else this.push(result.value);
      } catch (error) {
        this.destroy(error as Error);
      } finally {
        clearTimeout(timer);
      }
    },
    destroy(error, callback) {
      source.destroy(error ?? undefined);
      callback(error);
    },
  });
}
