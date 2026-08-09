import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";

/**
 * Single global semaphore guarding every LLM call the benchmark makes.
 *
 * Subtrees, candidates, and runs all fan out in parallel via Promise.all; this
 * gate is what actually caps the in-flight request count. The cap is set once
 * per scenario via `RunsConfig.maxInFlight` (default 4) and reset between
 * scenarios.
 *
 * Implementation: a permit pool of size N with FIFO waiters. Each `run(fn)`
 * waits for a permit, runs fn, and releases — even on error.
 */
@Injectable()
export class LlmCallGate {
  private readonly logger = new CustomLogger(LlmCallGate.name);
  private permits = 1;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  /** Set the cap for the upcoming scenario. Idempotent; safe to call between scenarios. */
  configure(maxInFlight: number): void {
    if (!Number.isFinite(maxInFlight) || maxInFlight < 1) {
      throw new Error(
        `LlmCallGate: maxInFlight must be ≥ 1 (got ${maxInFlight})`,
      );
    }
    this.permits = Math.floor(maxInFlight);
    this.logger.log(`LLM call gate configured: maxInFlight=${this.permits}`);
  }

  /** Current number of calls actively executing. Useful for progress instrumentation. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Configured cap. Useful for progress instrumentation. */
  get cap(): number {
    return this.permits;
  }

  /**
   * Run `fn` under the gate: waits for a permit, runs fn, releases the permit
   * after fn settles (success or failure). Returns whatever fn returns.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.permits) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
