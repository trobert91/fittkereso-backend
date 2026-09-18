import { ProductSourceConfigProblem } from './product-source-config-validator.service';

/** The shape written into a failed task's `error` column for this failure. */
export interface ProductSourceConfigInvalidDetail {
  kind: 'product_source_config_invalid';
  sourceId: string;
  sourceName: string;
  message: string;
  problems: ProductSourceConfigProblem[];
}

/**
 * A task refused to run because the source's stored config does not match the
 * config schema.
 *
 * Its own class so the task managers can recognise it without matching on a
 * message string, and mark the task terminal: retrying reads the same config
 * and gets the same answer, so the usual three attempts behind an exponential
 * backoff would only produce three identical failures. Recovery is somebody
 * fixing the config, which queues fresh work of its own.
 *
 * It carries the structured problems rather than only a sentence, so the task
 * row records something a reader can act on — each bad path named — instead of
 * a stack trace pointing at the guard that threw.
 */
export class ProductSourceConfigInvalidError extends Error {
  public readonly detail: ProductSourceConfigInvalidDetail;

  constructor(
    source: { id: string; name: string },
    problems: ProductSourceConfigProblem[],
  ) {
    const message =
      `Product source "${source.name}" has an invalid config: ` +
      problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');

    super(message);
    this.name = 'ProductSourceConfigInvalidError';

    this.detail = {
      kind: 'product_source_config_invalid',
      sourceId: source.id,
      sourceName: source.name,
      message,
      problems,
    };
  }
}

/** Whether a thrown value is this failure, for the task managers' catch blocks. */
export function isProductSourceConfigInvalidError(
  error: unknown,
): error is ProductSourceConfigInvalidError {
  return error instanceof ProductSourceConfigInvalidError;
}
