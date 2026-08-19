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

  get(opName: ScrapeOperation['op']): OpHandler {
    const handler = this.handlers.get(opName);
    if (!handler) {
      throw new Error(`Unknown scrape op: ${opName}`);
    }
    return handler;
  }
}
