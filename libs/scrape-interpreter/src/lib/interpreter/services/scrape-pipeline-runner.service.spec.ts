import * as cheerio from 'cheerio';
import { ScrapeOperation } from '@fittkereso-backend/database';
import { ScrapePipelineRunnerService } from './scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from './scrape-op-registry.service';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';

function makeContext(html = '<html></html>'): ScrapeExecutionContext {
  const $ = cheerio.load(html);
  return {
    $,
    html,
    task: { id: 'task-1', url: 'https://example.com/x' } as any,
    vars: {},
    runtime: {
      getBrandNames: jest.fn().mockResolvedValue([]),
      getCategoryBySlug: jest.fn().mockResolvedValue(null),
    },
    opts: {},
  };
}

describe('ScrapePipelineRunnerService', () => {
  let registry: ScrapeOpRegistryService;
  let runner: ScrapePipelineRunnerService;

  beforeEach(() => {
    registry = new ScrapeOpRegistryService();
    runner = new ScrapePipelineRunnerService(registry);
  });

  it('pipes the output of each op into the next as the implicit current value', async () => {
    registry.register('identity' as any, (_ctx, input) => input);
    registry.register('appendSuffix' as any, (_ctx, input, op: any) => `${input}${op.value}`);

    const ops: ScrapeOperation[] = [
      { op: 'identity' } as any,
      { op: 'appendSuffix', value: '-b' } as any,
    ];

    const result = await runner.run(ops, makeContext(), 'a');
    expect(result).toBe('a-b');
  });

  it('stores a result under `as` and lets a later op read it via `on`', async () => {
    registry.register('identity' as any, (_ctx, input) => input);

    const ops: ScrapeOperation[] = [
      { op: 'identity', as: 'first' } as any,
      { op: 'identity', on: 'first' } as any,
    ];

    const ctx = makeContext();
    const result = await runner.run(ops, ctx, 'stored-value');

    expect(ctx.vars['first']).toBe('stored-value');
    expect(result).toBe('stored-value');
  });

  it('throws for an unregistered op name', async () => {
    const ops: ScrapeOperation[] = [{ op: 'doesNotExist' } as any];
    await expect(runner.run(ops, makeContext())).rejects.toThrow(
      /Unknown scrape op/,
    );
  });
});
