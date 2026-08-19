import { Injectable } from '@nestjs/common';
import { ScrapeOperation } from '@fittkereso-backend/database';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';
import { ScrapeOpRegistryService } from './scrape-op-registry.service';
import { PipelineHalt } from './pipeline-halt';

@Injectable()
export class ScrapePipelineRunnerService {
  constructor(private readonly registry: ScrapeOpRegistryService) {}

  // Runs an operation pipeline left-to-right against a shared execution
  // context. Each op reads its input either from the previous op's output
  // (functional-pipe style) or from a named `vars` entry via `on`, and may
  // additionally store its result under `as` for later ops to reference.
  // A guard op (assertContains/filterByNonEmpty) can throw PipelineHalt to
  // short-circuit the rest of the pipeline entirely — mirrors an early
  // `return` in the original hand-written extractors.
  public async run(
    ops: ScrapeOperation[],
    ctx: ScrapeExecutionContext,
    initialValue: unknown = undefined,
  ): Promise<unknown> {
    let current: unknown = initialValue;

    for (const op of ops) {
      const input = op.on !== undefined ? ctx.vars[op.on] : current;
      const handler = this.registry.get(op.op);

      try {
        current = await handler(ctx, input, op);
      } catch (error) {
        if (error instanceof PipelineHalt) {
          return error.value;
        }
        throw error;
      }

      if (op.as) {
        ctx.vars[op.as] = current;
      }
    }

    return current;
  }
}
