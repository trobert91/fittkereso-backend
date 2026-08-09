import { Injectable } from '@nestjs/common';

@Injectable()
export class RedditApiQueueService {
  private queue: Promise<void> = Promise.resolve();
  private readonly delayMs = 1000;

  public enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => operation());
    // advance the chain; swallow errors so the queue never stalls on failure
    this.queue = result.then(
      () => this.sleep(this.delayMs),
      () => this.sleep(this.delayMs),
    );
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
