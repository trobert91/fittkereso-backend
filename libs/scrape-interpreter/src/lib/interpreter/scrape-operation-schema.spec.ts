import { SCRAPE_OPERATION_NAMES } from '@fittkereso-backend/database';
import { ScrapeOpRegistryService } from './services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from './services/scrape-pipeline-runner.service';
import { ProductValueMapperService } from './services/product-value-mapper.service';
import { registerOps } from './ops/register-ops';

// The one invariant that rots.
//
// PRODUCT_SOURCE_CONFIG_SCHEMA's op enum is hand-written in libs/database and
// the runtime handlers are registered by hand in register-ops.ts. Nothing but
// this test connects the two, and both directions matter:
//
//  - an op in the registry but not the schema is implemented and reachable,
//    yet every config using it is rejected at save time;
//  - an op in the schema but not the registry validates clean and then throws
//    "Unknown scrape op" mid-pipeline, after the page fetch has been paid for.
//
// Whichever side a new op is added to first, this fails until the other
// catches up.
describe('scrape operation schema', () => {
  let registry: ScrapeOpRegistryService;

  beforeAll(() => {
    registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());
  });

  it('lists exactly the ops the interpreter can run', () => {
    const registered = [...registry.names()].sort();
    const declared = [...SCRAPE_OPERATION_NAMES].sort();

    expect(declared).toEqual(registered);
  });

  it('declares no op the registry cannot run', () => {
    const registered = new Set<string>(registry.names());
    const schemaOnly = SCRAPE_OPERATION_NAMES.filter((name) => !registered.has(name));

    expect(schemaOnly).toEqual([]);
  });

  it('omits no op the registry can run', () => {
    const declared = new Set<string>(SCRAPE_OPERATION_NAMES);
    const registryOnly = registry.names().filter((name) => !declared.has(name));

    expect(registryOnly).toEqual([]);
  });
});
