import * as cheerio from 'cheerio';
import { makeBranch } from './control-ops';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';

function makeContext(vars: Record<string, unknown> = {}): ScrapeExecutionContext {
  const $ = cheerio.load('<div class="present"></div>');
  return { $, html: '', task: {} as any, vars, runtime: {} as any, opts: {} };
}

describe('branch', () => {
  let runner: ScrapePipelineRunnerService;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    registry.register('identity', (_ctx, input) => input);
    runner = new ScrapePipelineRunnerService(registry);
  });

  it('takes ifTrue when selectorExists matches', async () => {
    const branch = makeBranch(runner);
    const ctx = makeContext();
    const result = await branch(ctx, undefined, {
      op: 'branch',
      condition: { selectorExists: '.present' },
      ifTrue: [{ op: 'identity', value: undefined } as never],
      ifFalse: [],
    });
    expect(result).toBeUndefined(); // ifTrue ran (empty pipeline result), not throw
  });

  it('takes ifFalse when equals condition does not match', async () => {
    const ctx = makeContext({ sale: false });
    let branchTaken: 'true' | 'false' | undefined;
    const registry = new ScrapeOpRegistryService();
    registry.register('markTrue' as never, () => {
      branchTaken = 'true';
      return undefined;
    });
    registry.register('markFalse' as never, () => {
      branchTaken = 'false';
      return undefined;
    });
    const localRunner = new ScrapePipelineRunnerService(registry);
    const localBranch = makeBranch(localRunner);

    await localBranch(ctx, undefined, {
      op: 'branch',
      condition: { equals: { value: 'sale', to: true } },
      ifTrue: [{ op: 'markTrue' } as never],
      ifFalse: [{ op: 'markFalse' } as never],
    });

    expect(branchTaken).toBe('false');
  });

  it('takes ifTrue when equals condition matches', async () => {
    const ctx = makeContext({ sale: true });
    let branchTaken: 'true' | 'false' | undefined;
    const registry = new ScrapeOpRegistryService();
    registry.register('markTrue' as never, () => {
      branchTaken = 'true';
      return undefined;
    });
    registry.register('markFalse' as never, () => {
      branchTaken = 'false';
      return undefined;
    });
    const localRunner = new ScrapePipelineRunnerService(registry);
    const localBranch = makeBranch(localRunner);

    await localBranch(ctx, undefined, {
      op: 'branch',
      condition: { equals: { value: 'sale', to: true } },
      ifTrue: [{ op: 'markTrue' } as never],
      ifFalse: [{ op: 'markFalse' } as never],
    });

    expect(branchTaken).toBe('true');
  });

  it('throws when no recognized condition key is present', async () => {
    const branch = makeBranch(runner);
    const ctx = makeContext();
    await expect(
      branch(ctx, undefined, {
        op: 'branch',
        condition: {} as never,
        ifTrue: [],
        ifFalse: [],
      }),
    ).rejects.toThrow('branch: condition must specify');
  });
});
