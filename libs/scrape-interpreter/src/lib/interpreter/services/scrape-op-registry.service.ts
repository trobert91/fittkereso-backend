import { Injectable } from '@nestjs/common';
import { ScrapeOperation } from '@fittkereso-backend/database';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';

export type OpHandler<TOp extends ScrapeOperation = ScrapeOperation> = (
  ctx: ScrapeExecutionContext,
  input: unknown,
  op: TOp,
) => unknown | Promise<unknown>;

@Injectable()
export class ScrapeOpRegistryService {
  private readonly handlers = new Map<ScrapeOperation['op'], OpHandler<any>>();

  register<TOp extends ScrapeOperation>(
    opName: TOp['op'],
    handler: OpHandler<TOp>,
  ): void {
    if (this.handlers.has(opName)) {
      throw new Error(`Duplicate scrape op handler registered: ${opName}`);
    }
    this.handlers.set(opName, handler);
  }

  /**
   * Every op this process can actually run.
   *
   * Exists so the JSON Schema's op enum can be checked against reality — see
   * scrape-operation-schema.spec.ts. The schema is hand-written and the
   * registry is populated by hand, so the two drifting apart is the one
   * failure this vocabulary is genuinely prone to: a new op reachable at
   * runtime but rejected by validation, or listed as valid and then unknown
   * mid-scrape.
   */
  names(): ScrapeOperation['op'][] {
    return [...this.handlers.keys()];
  }

  get(opName: ScrapeOperation['op']): OpHandler {
    const handler = this.handlers.get(opName);
    if (!handler) {
      throw new Error(`Unknown scrape op: ${opName}`);
    }
    return handler;
  }
}
