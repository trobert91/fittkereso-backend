import { BranchOp } from '@fittkereso-backend/database';
import { CheerioSelection } from '../interfaces/scrape-execution-context.interface';
import { OpHandler } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof (value as CheerioSelection)?.length === 'number') {
    return (value as CheerioSelection).length === 0;
  }
  return false;
}

export function makeBranch(
  runner: ScrapePipelineRunnerService,
): OpHandler<BranchOp> {
  return async (ctx, input, op) => {
    let conditionTrue: boolean;

    if (op.condition.selectorExists !== undefined) {
      conditionTrue = ctx.$(op.condition.selectorExists).length > 0;
    } else if (op.condition.isEmpty !== undefined) {
      conditionTrue = isEmptyValue(ctx.vars[op.condition.isEmpty]);
    } else if (op.condition.equals !== undefined) {
      conditionTrue = ctx.vars[op.condition.equals.value] === op.condition.equals.to;
    } else {
      throw new Error(
        'branch: condition must specify selectorExists, isEmpty, or equals',
      );
    }

    const branchOps = conditionTrue ? op.ifTrue : op.ifFalse;
    return runner.run(branchOps, ctx, input);
  };
}
