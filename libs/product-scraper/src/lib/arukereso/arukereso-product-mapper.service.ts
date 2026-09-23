import { Injectable } from '@nestjs/common';
import {
  ArukeresoMappingTarget,
  ArukeresoSourceConfig,
  OfferAvailability,
  ProductSource,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ProductSpecs,
  ScrapedProduct,
  ScrapedProductSpec,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  DeterministicProductData,
  SpecExtractionService,
} from '@fittkereso-backend/product';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ScrapeInterpreterService } from '@fittkereso-backend/scrape-interpreter';
import { RuntimeDataProviderService } from '@fittkereso-backend/scrape-interpreter';
import { canonicalizeProductUrl, normalizeUrl } from '@fittkereso-backend/utils';
import { pick, omit } from 'lodash';
import {
  ArukeresoFeedItem,
  feedField,
  normalizeFieldName,
} from './arukereso-feed-item';
import { ProductImportContext } from '../interfaces/product-import-context.interface';
import { SpecPostProcessService } from '../product-scraper/services/spec-post-process.service';
import { splitDeterministicSpecs } from '../product-scraper/services/deterministic-specs';
import { matchesFilter } from '../product-scraper/services/source-item-filter';

/**
 * Why an item produced no product. Counted per run rather than logged per item:
 * on a 3488-product feed a per-item warn is noise, but "1398 items skipped,
 * every one of them category_not_enabled" is the answer to what happened.
 */
export type FeedSkipReason =
  | 'filtered_out'
  | 'missing_url'
  | 'missing_brand'
  | 'missing_name'
  | 'missing_price'
  | 'category_not_identified'
  | 'category_not_enabled'
  | 'category_not_requested'
  | 'category_not_in_database'
  | 'category_missing_schema';

export type MappedFeedItem =
  | { status: 'mapped'; scrapedProduct: ScrapedProduct; url: string }
  | { status: 'skipped'; reason: FeedSkipReason };

/**
 * One Árukereső feed item -> one ScrapedProduct.
 *
 * Everything past this point is shared with the scraping path: identity
 * resolution, merge, spec validation and offer upsert neither know nor care
 * that this product arrived as a feed row. The mapper's whole job is producing
 * the same object a detail-page scrape produces.
 *
 * It deliberately mirrors ProductDetailsPageScraperService.extractProduct step
 * for step — deterministic spec extraction, the offer/product split, the two
 * hashes, the post-process pass — and shares the parts where a divergence would
 * actually cost something (splitDeterministicSpecs, SpecPostProcessService).
 * What differs is only where the values come from: feed fields addressed by
 * name rather than DOM queries.
 */
@Injectable()
export class ArukeresoProductMapperService {
  constructor(
    private readonly interpreter: ScrapeInterpreterService,
    private readonly runtime: RuntimeDataProviderService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly specExtraction: SpecExtractionService,
    private readonly specPostProcess: SpecPostProcessService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
  ) {}

  public async map(params: {
    source: ProductSource;
    config: ArukeresoSourceConfig;
    item: ArukeresoFeedItem;
    /** Narrows the run to these slugs; empty means every enabled category. */
    requestedSlugs?: string[];
    force?: boolean;
  }): Promise<MappedFeedItem> {
    const { source, config, item, requestedSlugs, force } = params;

    // Checked here as well as in classify(), because the import path calls this
    // method directly — a filter that only applied to the simulator would look
    // right in a dry run and import the whole catalogue for real.
    if (!matchesFilter(config.filter, (field) => this.filterValue(item, field))) {
      return { status: 'skipped', reason: 'filtered_out' };
    }

    const rawUrl = await this.resolve(config, item, 'url');
    if (!rawUrl) return { status: 'skipped', reason: 'missing_url' };
    const url = canonicalizeProductUrl(String(rawUrl));

    const categoryOutcome = await this.resolveCategory(
      config,
      item,
      requestedSlugs,
    );
    if (categoryOutcome.status === 'skipped') return categoryOutcome;
    const { category, jsonSchema } = categoryOutcome;

    const brand = this.asString(await this.resolve(config, item, 'brand'));
    if (!brand) return { status: 'skipped', reason: 'missing_brand' };

    // The raw marketing title, exactly as the detail path treats a page title:
    // required to be present, not required to be clean. The post-process pass
    // below is what turns it into a model name.
    const rawName = this.asString(await this.resolve(config, item, 'name'));
    if (!rawName) return { status: 'skipped', reason: 'missing_name' };

    const price = this.asNumber(await this.resolve(config, item, 'price'));
    if (price === undefined) return { status: 'skipped', reason: 'missing_price' };

    const externalId = this.asString(
      await this.resolve(config, item, 'externalId'),
    );
    const description = this.asString(
      await this.resolve(config, item, 'description'),
    );
    const context: ProductImportContext = { source, url, force };

    const offerLevelKeys =
      this.categoryConfigService.getConfig(category.slug)?.offerLevelSpecs ?? [];
    const sourceSpecConfig = config.specMapping?.[category.slug];

    const rawSpecs = this.toRawSpecs(item);
    const deterministicSpecs = sourceSpecConfig
      ? this.specExtraction.extractSpecs({
          scrapedSpecs: rawSpecs,
          schema: jsonSchema,
          sourceConfig: sourceSpecConfig,
        })
      : {};

    const releaseYear = this.asNumber(
      await this.resolve(config, item, 'releaseYear'),
    );
    if (deterministicSpecs['modelYear'] === undefined && releaseYear !== undefined) {
      deterministicSpecs['modelYear'] = releaseYear;
    }

    const {
      offerLevelDeterministicSpecs,
      productLevelDeterministicSpecs,
      offerSpecsHash,
      productSpecsHash,
    } = splitDeterministicSpecs(deterministicSpecs, offerLevelKeys);

    const existingSource = await this.findExistingSource(source, externalId, url);
    const existingOfferForSpecs =
      existingSource?.offers?.find((o) => o.externalId === externalId) ??
      existingSource?.offers?.[0];

    const offerIdentitySameRecordHit =
      !force && existingSource?.offerSpecsHash === offerSpecsHash;
    const productSpecsSameRecordHit =
      !force && existingSource?.productSpecsHash === productSpecsHash;

    const offerFields = await this.resolveOfferFields(config, item, url, price);

    // Both halves unchanged — no fresh LLM work at all. This is the path the
    // overwhelming majority of a nightly feed run takes, and it is the whole
    // reason the hashes exist: a 3488-item feed whose catalogue barely moved
    // costs two LLM calls for the handful of products that did.
    if (offerIdentitySameRecordHit && productSpecsSameRecordHit) {
      const model = existingSource?.model?.model ?? rawName;
      const existingOfferLevelSpecs = pick(
        existingOfferForSpecs?.specs,
        offerLevelKeys,
      );
      return {
        status: 'mapped',
        url,
        scrapedProduct: {
          brand,
          model,
          displayName: `${brand} ${model}`.trim(),
          originalName: rawName,
          category: {
            id: category.id,
            slug: category.slug,
            name: category.name,
          },
          externalId,
          aliases: await this.resolveAliases(config, item),
          images: await this.resolveImages(config, item),
          offers: [{ ...offerFields, specs: existingOfferLevelSpecs }],
        },
      };
    }

    const deterministicData: DeterministicProductData = {
      brand,
      model: rawName,
      specs: deterministicSpecs,
    };

    const { brand: cleanBrand, model, specs } = await this.specPostProcess.resolve(
      {
        context,
        config: config.postProcess,
        data: deterministicData,
        offerLevelDeterministicSpecs,
        productLevelDeterministicSpecs,
        rawSpecs,
        description,
        productSpecsHash,
        jsonSchema,
        categorySlug: category.slug,
        offerIdentitySameRecordHit,
        existingSource: existingSource ?? undefined,
        existingOfferForSpecs,
        offerLevelKeys,
      },
    );

    // Offer-level keys never reach the shared ProductModel/ProductSourceRecord
    // specs — they vary between the very offers a ProductModel groups, so they
    // have no single correct value at the model level.
    const pageOfferLevelSpecs = pick(specs, offerLevelKeys);

    return {
      status: 'mapped',
      url,
      scrapedProduct: {
        brand: cleanBrand,
        model,
        displayName: `${cleanBrand} ${model}`.trim(),
        originalName: rawName,
        category: { id: category.id, slug: category.slug, name: category.name },
        specs: omit(specs, offerLevelKeys),
        extractedSpecs: deterministicSpecs,
        offerLevelDeterministicSpecs,
        productLevelDeterministicSpecs,
        offerSpecsHash,
        productSpecsHash,
        rawSpecs,
        description,
        externalId,
        aliases: await this.resolveAliases(config, item),
        images: await this.resolveImages(config, item),
        offers: [{ ...offerFields, specs: pageOfferLevelSpecs }],
      },
    };
  }

  /**
   * Read one mapping target off the item.
   *
   * `field` does the addressing — matched case-insensitively with separators
   * stripped, because the same field has at least three spellings in the wild —
   * and the optional pipeline does the transforming. That division is why this
   * source type needs no scrape ops of its own.
   */
  private async resolve(
    config: ArukeresoSourceConfig,
    item: ArukeresoFeedItem,
    target: ArukeresoMappingTarget,
  ): Promise<unknown> {
    const mapping = config.mapping[target];
    if (!mapping) return undefined;

    // No field means the pipeline supplies its own value — a `literal` currency
    // code, say, for a format that has no field to carry one.
    const raw = mapping.field ? feedField(item, mapping.field) : undefined;
    if (!mapping.pipeline?.length) return raw;

    return this.interpreter.runValuePipeline(mapping.pipeline, raw, {
      baseUrl: config.baseUrl,
    });
  }

  /**
   * The category gate alone — no spec extraction, no hashes, no LLM.
   *
   * Exists so a whole feed can be counted cheaply: "this gate keeps 2090 of
   * 3486" is the single most useful number when onboarding a feed shop, and
   * getting it by mapping every item in full would mean paying for thousands of
   * LLM calls to answer a question the gate settles on its own.
   */
  public async classify(
    config: ArukeresoSourceConfig,
    item: ArukeresoFeedItem,
    requestedSlugs?: string[],
  ): Promise<
    { status: 'eligible'; slug: string } | { status: 'skipped'; reason: FeedSkipReason }
  > {
    // The config filter runs FIRST, before the category gate, because it is the
    // cheaper test and because its whole purpose is cutting the run down.
    if (!matchesFilter(config.filter, (field) => this.filterValue(item, field))) {
      return { status: 'skipped', reason: 'filtered_out' };
    }

    const outcome = await this.resolveCategory(config, item, requestedSlugs);
    return outcome.status === 'skipped'
      ? outcome
      : { status: 'eligible', slug: outcome.category.slug };
  }

  /**
   * Resolve a filter condition's `field` against a feed item.
   *
   * Any column, by any of its spellings — the same normalization `mapping`
   * uses, so a filter and a mapping can name a field identically. The
   * `attribute:<name>` prefix reaches the feed's spec pairs, which is where
   * most of what you would want to filter on actually lives (motor, frame
   * size, wheel size) — those are not columns at all.
   */
  private filterValue(item: ArukeresoFeedItem, field: string): unknown {
    const attributePrefix = 'attribute:';
    if (field.toLowerCase().startsWith(attributePrefix)) {
      const wanted = normalizeFieldName(field.slice(attributePrefix.length));
      return item.attributes.find(
        (attribute) => normalizeFieldName(attribute.name) === wanted,
      )?.value;
    }

    return feedField(item, field);
  }

  /**
   * Which of our categories this item belongs to, and whether we want it.
   *
   * The `categories.<slug>.enabled` gate is doing real work here in a way it
   * never does on a scraping source: a feed is the entire catalogue, so this is
   * the only thing keeping the 1396 non-e-bikes of speedbike's 3486 products
   * out of the database.
   */
  private async resolveCategory(
    config: ArukeresoSourceConfig,
    item: ArukeresoFeedItem,
    requestedSlugs: string[] | undefined,
  ): Promise<
    | { status: 'skipped'; reason: FeedSkipReason }
    | {
        status: 'resolved';
        category: { id: string; slug: string; name: string };
        jsonSchema: SpecDefinitionJsonSchema;
      }
  > {
    const rawLabel = this.asString(
      await this.resolve(config, item, 'categoryLabel'),
    );
    const label = config.category.labelFrom?.length
      ? this.asString(
          await this.interpreter.runValuePipeline(
            config.category.labelFrom,
            rawLabel,
            { baseUrl: config.baseUrl },
          ),
        )
      : rawLabel;

    // The feed's attributes are passed in as raw specs so a slugLookup rule can
    // use `specValueIncludes` exactly as it does against a page's spec table —
    // which is what lets a shop that is both scraped and fed share its rules.
    const slug = this.interpreter.resolveCategoryFromRules(
      config.category.slugLookup,
      label,
      this.toRawSpecs(item),
    );
    if (!slug) return { status: 'skipped', reason: 'category_not_identified' };

    if (!config.categories?.[slug]?.enabled) {
      return { status: 'skipped', reason: 'category_not_enabled' };
    }
    if (requestedSlugs?.length && !requestedSlugs.includes(slug)) {
      return { status: 'skipped', reason: 'category_not_requested' };
    }

    const category = await this.runtime.getCategoryBySlug(slug);
    if (!category) {
      return { status: 'skipped', reason: 'category_not_in_database' };
    }

    const jsonSchema = this.categoryConfigService.getJsonSchema(slug);
    if (!jsonSchema) {
      return { status: 'skipped', reason: 'category_missing_schema' };
    }

    return {
      status: 'resolved',
      category: { id: category.id, slug: category.slug, name: category.name },
      jsonSchema,
    };
  }

  /**
   * The offer, minus its specs.
   *
   * A feed row is always exactly one offer: Árukereső's format has no way to
   * express several sellers or several variants under one product, so unlike a
   * detail page there is nothing here to iterate.
   */
  private async resolveOfferFields(
    config: ArukeresoSourceConfig,
    item: ArukeresoFeedItem,
    url: string,
    price: number,
  ): Promise<{
    price: number;
    priceWithoutDiscount?: number;
    currency?: string;
    /** Always set on this path — see toAvailability for why silence means in stock. */
    availability: OfferAvailability;
    url: string;
    externalId?: string;
  }> {
    return {
      price,
      priceWithoutDiscount: this.asNumber(
        await this.resolve(config, item, 'priceWithoutDiscount'),
      ),
      currency: this.asString(await this.resolve(config, item, 'currency')),
      availability: this.toAvailability(
        this.asString(await this.resolve(config, item, 'availability')),
      ),
      url: normalizeUrl(url),
      externalId: this.asString(await this.resolve(config, item, 'externalId')),
    };
  }

  private async resolveAliases(
    config: ArukeresoSourceConfig,
    item: ArukeresoFeedItem,
  ): Promise<string[] | undefined> {
    const value = await this.resolve(config, item, 'aliases');
    if (value === undefined) return undefined;
    return Array.isArray(value)
      ? value.map(String).filter(Boolean)
      : [String(value)].filter(Boolean);
  }

  /**
   * Árukereső's own format carries one image per product, but a shop is free to
   * emit several (ShopRenter puts extras in repeated fields), and a pipeline may
   * split one field into many — so an array is accepted as well as a string.
   */
  private async resolveImages(
    config: ArukeresoSourceConfig,
    item: ArukeresoFeedItem,
  ): Promise<{ url: string; order: number }[] | undefined> {
    const value = await this.resolve(config, item, 'imageUrl');
    if (value === undefined) return undefined;

    const urls = (Array.isArray(value) ? value : [value])
      .map((entry) => this.asString(entry))
      .filter((entry): entry is string => !!entry);

    return urls.length ? urls.map((url, order) => ({ url, order })) : undefined;
  }

  /** Prefers the source-native id; falls back to the URL, as the detail path does. */
  private async findExistingSource(
    source: ProductSource,
    externalId: string | undefined,
    url: string,
  ): Promise<ProductSourceRecord | null> {
    if (externalId) {
      return this.sourceRecordRepo.findBySourceAndExternalId(
        source.id,
        externalId,
      );
    }
    return this.sourceRecordRepo.findBySourceAndUrl(source.id, normalizeUrl(url));
  }

  /**
   * The feed's attribute pairs as raw spec rows.
   *
   * This is the half that transfers for free: an Árukereső feed's
   * `attribute_name` values are typically the same labels the shop's own spec
   * table uses, so an existing scraping source's specMapping usually works
   * verbatim — speedbike's 58 ebike mappings do.
   */
  private toRawSpecs(item: ArukeresoFeedItem): ScrapedProductSpec[] {
    return item.attributes.map((attribute) => ({
      name: attribute.name,
      values: [attribute.value],
    }));
  }

  /**
   * Stock status for a feed row.
   *
   * **Being in the feed is itself the signal.** A shop generates its Árukereső
   * feed from what it is currently offering, so a product's presence means it
   * can be bought — `in_stock` is the correct reading of silence here, not a
   * guess. That is why this differs from the scraping path, where silence
   * really is an absence of information: a product page exists whether or not
   * the thing is orderable.
   *
   * The feed can still say otherwise, and then it wins — Árukereső's
   * `DeliveryTime: "NO"` is its documented "not orderable" marker.
   *
   * A value the config produced but we cannot map stays `unknown` rather than
   * falling back to the default: that is the one case where the feed DID carry
   * more specific information and we failed to read it, which is a config bug
   * worth surfacing rather than papering over. A config that wants the default
   * for unmatched values says so with its own `mapValue` default.
   */
  private toAvailability(value: string | undefined): OfferAvailability {
    if (!value) return OfferAvailability.in_stock;
    return (Object.values(OfferAvailability) as string[]).includes(value)
      ? (value as OfferAvailability)
      : OfferAvailability.unknown;
  }

  private asString(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text === '' ? undefined : text;
  }

  /**
   * Árukereső's own examples show prices with a comma decimal separator
   * (`379,97`), and Hungarian shops space- or dot-group thousands — so a bare
   * Number() would read `1 299 000` as NaN and `379,97` as NaN too.
   */
  private asNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }

    // Whitespace of every kind, non-breaking space included — Hungarian
    // shops group thousands with one.
    const text = String(value).trim().replace(/[\s ]/g, '');
    // Which separator is the decimal point is decided by what FOLLOWS it: a
    // grouping separator is always followed by exactly three digits, so one or
    // two trailing digits identify the decimal. Everything else is grouping and
    // is stripped — `1.299.000` and `1,299,000` are both 1299000, while
    // `379,97` and `379.97` are both 379.97. Guessing by separator alone cannot
    // work here: Hungarian shops group with dots, and Árukereső's own examples
    // use a comma decimal.
    const lastSeparator = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
    const trailingDigits =
      lastSeparator === -1 ? 0 : text.length - lastSeparator - 1;
    const isDecimal = trailingDigits >= 1 && trailingDigits <= 2;

    const normalized = isDecimal
      ? `${text.slice(0, lastSeparator).replace(/[.,]/g, '')}.${text.slice(
          lastSeparator + 1,
        )}`
      : text.replace(/[.,]/g, '');

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

}
