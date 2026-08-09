import type { ResolutionContext } from '../models/resolution-context';
import type { ProductResolutionInput } from '../models/resolution-input';
import type { ResolutionOptions } from '../models/resolution-options';
import { ResolutionStatus } from '../models/resolution-status';

/**
 * Test helper: build a minimally-populated `ResolutionContext` for unit tests
 * that don't want to construct every required field by hand.
 *
 * Lives under `lib/testing/` so it's not part of the public barrel.
 */
export function makeTestContext(
  overrides: Partial<ResolutionContext> & {
    input?: ProductResolutionInput;
    options?: Partial<ResolutionOptions>;
  } = {},
): ResolutionContext {
  const input = overrides.input ?? {};
  const options: ResolutionOptions = {
    useEmbedding: true,
    webSearchEnabled: false,
    mode: 'loose',
    ...overrides.options,
  };
  return {
    input,
    options,
    modelVariants: [],
    searchedKeywords: [],
    searchEvidence: [],
    candidates: [],
    strategiesRun: [],
    status: ResolutionStatus.INPUT_RECEIVED,
    totals: { durationMs: 0, cost: 0, llmCalls: 0, webSearchCalls: 0 },
    errors: [],
    ...overrides,
  };
}
