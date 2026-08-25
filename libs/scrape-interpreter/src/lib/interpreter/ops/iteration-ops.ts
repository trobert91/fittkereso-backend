import { ForEachItemOp } from '@fittkereso-backend/database';
import { CheerioSelection } from '../interfaces/scrape-execution-context.interface';
import { OpHandler } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';

// Runs op.itemPipeline once per entry of the input collection. Each
// iteration gets its own cloned `vars` — never the shared ctx.vars object —
// so an `as`-stored value from one item's sub-pipeline (e.g. an `onSale`
// boolean) can never leak into the next item. This is the first op in the
// vocabulary to introduce per-branch-scoped vars; every other op mutates one
// shared vars object for the whole pipeline run.
export function makeForEachItem(
  runner: ScrapePipelineRunnerService,
): OpHandler<ForEachItemOp> {
  return async (ctx, input, op) => {
    const itemVar = op.itemVar ?? 'item';
    const indexVar = op.indexVar ?? 'itemIndex';
    const skipEmptyResults = op.skipEmptyResults ?? true;

    const items: unknown[] =
      op.itemMode === 'cheerio'
        ? (input as CheerioSelection).toArray().map((el) => ctx.$(el))
        : ((input as unknown[]) ?? []);

    const results: unknown[] = [];
    for (let index = 0; index < items.length; index++) {
      const itemValue = items[index];
      const itemCtx = {
        ...ctx,
        vars: { ...ctx.vars, [itemVar]: itemValue, [indexVar]: index },
      };
      const result = await runner.run(op.itemPipeline, itemCtx, itemValue);
      if (skipEmptyResults && (result === undefined || result === null)) {
        continue;
      }
      results.push(result);
    }

    return results;
  };
}
