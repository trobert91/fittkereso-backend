import { BadRequestException, Injectable } from '@nestjs/common';
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import {
  ARUKERESO_SOURCE_CONFIG_SCHEMA,
  SCRAPING_SOURCE_CONFIG_SCHEMA,
} from '../types/product-source-config.schema';
import {
  PRODUCT_SOURCE_TYPES,
  ProductSourceType,
} from '../types/product-source-type';
import { JsonSchemaFragment } from '../types/scrape-operation.schema';

/** One thing wrong with a config, at the path it is wrong at. */
export interface ProductSourceConfigProblem {
  /** JSON Pointer into the config, e.g. "/listPage/productLinks/0". "(root)" for the whole object. */
  path: string;
  message: string;
}

/** At most this many problems in one report. Past that it is a wall, not a report. */
const MAX_REPORTED_PROBLEMS = 10;

/** Beyond this many, an enum's allowed values are summarised rather than listed. */
const MAX_LISTED_ALLOWED_VALUES = 8;

/**
 * Validates a ProductSource.config against PRODUCT_SOURCE_CONFIG_SCHEMA.
 *
 * Two forms, deliberately kept apart because they serve different moments:
 *
 *  - `assertValid` throws, and is what the SAVE path uses. A config that
 *    cannot run should never reach the column in the first place.
 *  - `problems` returns instead of throwing, and is what the RUN path uses. A
 *    config stored before the schema existed — or before a later op rename —
 *    has to fail ONE TASK with a readable reason, not throw out of a task
 *    manager and take the rest of the poll tick with it.
 *
 * Ajv 2020 rather than the default export: the schema leans on
 * `unevaluatedProperties`, which is draft 2019-09 and later. The default Ajv
 * class is draft-07 and would silently ignore it, which would quietly turn a
 * typo'd op parameter back into an accepted key.
 *
 * The validator compiles ONCE, in the constructor. There is exactly one
 * schema for every source — it describes this codebase's op vocabulary, not a
 * per-source query grammar — so there is nothing to cache and nothing to
 * evict. `compile()` generates and evals a function, which is the expensive
 * part, and doing it per request would pay for it repeatedly.
 */
@Injectable()
export class ProductSourceConfigValidatorService {
  private readonly ajv: Ajv2020;
  /**
   * One compiled validator per source type. The scraping and feed shapes share
   * no keys; the two feed types share one.
   */
  private readonly validators: Record<ProductSourceType, ValidateFunction>;
  private readonly schemas: Record<ProductSourceType, JsonSchemaFragment>;

  constructor() {
    // `strict: false` for the reason every other ajv in this repo uses it:
    // strict mode objects to legal JSON Schema it happens to dislike, and a
    // schema that fails to compile here would take the whole app down at boot.
    // `allErrors` so one report names every problem instead of only the first.
    // `verbose` so each error carries the value that failed — without it an
    // "must be equal to one of the allowed values" cannot name the bad op.
    this.ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
    this.schemas = {
      scraping: SCRAPING_SOURCE_CONFIG_SCHEMA,
      arukereso: ARUKERESO_SOURCE_CONFIG_SCHEMA,
      googleshop: ARUKERESO_SOURCE_CONFIG_SCHEMA,
    };

    const feed = this.ajv.compile(ARUKERESO_SOURCE_CONFIG_SCHEMA);
    this.validators = {
      scraping: this.ajv.compile(SCRAPING_SOURCE_CONFIG_SCHEMA),
      arukereso: feed,
      googleshop: feed,
    };
  }

  /**
   * The schema for one source type, for the admin config editor and the MCP
   * tools. Which one applies is decided by ProductSource.type, which is fixed
   * at creation.
   */
  public schemaFor(type: ProductSourceType): JsonSchemaFragment {
    return this.schemas[type];
  }

  /** Every schema, keyed by type — for tools that document all of them. */
  public get allSchemas(): Record<ProductSourceType, JsonSchemaFragment> {
    return this.schemas;
  }

  /**
   * What is wrong with this config, or null when nothing is.
   *
   * The non-throwing form. Callers that must not throw — the run-time guards,
   * the audit tool — use this and decide for themselves what a problem means.
   */
  public problems(
    type: ProductSourceType,
    config: unknown,
  ): ProductSourceConfigProblem[] | null {
    const validator = this.validators[type];

    if (!validator) {
      return [
        {
          path: '(root)',
          message:
            `Unknown product source type "${type}" — expected one of ` +
            `${PRODUCT_SOURCE_TYPES.join(', ')}.`,
        },
      ];
    }

    if (validator(config)) {
      return null;
    }

    return this.summarise(validator.errors ?? []);
  }

  /** The throwing form, for the write path. */
  public assertValid(type: ProductSourceType, config: unknown): void {
    const problems = this.problems(type, config);
    if (problems) {
      throw new BadRequestException(
        `The ${type} product source config is not valid: ` +
          this.format(problems),
      );
    }
  }

  /** Renders problems as one line, the form an API message or a log wants. */
  public format(problems: ProductSourceConfigProblem[]): string {
    return problems.map((p) => `${p.path}: ${p.message}`).join('; ');
  }

  /**
   * Turns ajv's raw errors into the few that actually say something.
   *
   * Two kinds of noise have to go first, both produced by the discriminated
   * `allOf` the operation schema is built from:
   *
   *  - `if` errors ("must match \"then\" schema"). Pure structure: they
   *    restate that a branch failed, which the branch's own error already
   *    said.
   *  - `unevaluatedProperties` errors on an operation whose `op` itself
   *    failed. When an op name is wrong NO branch matches, so every one of
   *    that op's parameters is reported as unevaluated — a dozen lines that
   *    all mean "the op name is wrong".
   *
   * Note the second rule keys off `<path>/op` failing specifically, not off
   * the path having any error at all. A typo'd parameter produces BOTH a
   * `required` error and an unevaluated one ("must have required property
   * 'selector'" + `("selectr")`), and those two together are the whole
   * diagnosis — dropping either would leave the reader guessing.
   */
  private summarise(errors: ErrorObject[]): ProductSourceConfigProblem[] {
    const meaningful = errors.filter((error) => error.keyword !== 'if');

    const opsWithBadName = new Set(
      meaningful
        .filter((error) => error.instancePath.endsWith('/op'))
        .map((error) => error.instancePath.slice(0, -'/op'.length)),
    );

    // At the op's own path, and at every ancestor: a bad op nested in an
    // assembleOffer sub-pipeline fails that assembleOffer's branch too, which
    // reports the enclosing op's own parameters as unevaluated in turn.
    const explainedByBadOp = (path: string): boolean =>
      [...opsWithBadName].some(
        (badOp) => badOp === path || badOp.startsWith(`${path}/`),
      );

    const kept = meaningful.filter(
      (error) =>
        error.keyword !== 'unevaluatedProperties' ||
        !explainedByBadOp(error.instancePath),
    );

    const problems = kept
      .slice(0, MAX_REPORTED_PROBLEMS)
      .map((error) => ({
        path: error.instancePath || '(root)',
        message: this.detailOf(error),
      }));

    const more = kept.length - problems.length;
    if (more > 0) {
      problems.push({ path: '(root)', message: `and ${more} more problem(s)` });
    }

    return problems;
  }

  /**
   * One error's text, with the part ajv hides in `params` pulled into it.
   *
   * Ajv reports an unexpected key as "must NOT have additional properties"
   * and puts the offending NAME in params — so on an object with twenty keys
   * the default message says a config has a key it should not without saying
   * which. Same for an enum, whose allowed values are in params. An error
   * somebody cannot act on is barely an error.
   *
   * Allowed values are listed only while the list is short. The op
   * discriminator has 53 of them, and printing all 53 to say "selectTxt is
   * not one of these" buries the one word that mattered. Naming the offending
   * value instead is what `verbose` is switched on for.
   */
  private detailOf(error: ErrorObject): string {
    const message = error.message ?? 'is invalid';
    const params = error.params as Record<string, unknown> | undefined;

    const unknownKey = params?.['additionalProperty'] ?? params?.['unevaluatedProperty'];
    if (typeof unknownKey === 'string') {
      return `${message} ("${unknownKey}")`;
    }

    const allowedValues = params?.['allowedValues'];
    if (Array.isArray(allowedValues)) {
      const got = this.describeValue(error.data);
      if (allowedValues.length > MAX_LISTED_ALLOWED_VALUES) {
        return got ? `${message}${got}` : message;
      }
      const allowed = allowedValues.map((value) => JSON.stringify(value)).join(', ');
      return `${message}${got} (allowed: ${allowed})`;
    }

    return message;
  }

  /** ` — got "selectTxt"`, when the failing value is worth quoting. */
  private describeValue(data: unknown): string {
    if (data === undefined || data === null) return '';
    if (typeof data === 'object') return '';
    return ` — got ${JSON.stringify(data)}`;
  }
}
