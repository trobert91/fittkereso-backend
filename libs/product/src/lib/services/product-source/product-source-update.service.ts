import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ProductSource,
  ProductSourceActor,
  ProductSourceRepository,
  Seller,
  SellerRepository,
  systemActor,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import ms from 'ms';
import { ProductSourceUpdateParams } from '../../models/product-source-update-params';
import { ProductSourceVersionService } from './product-source-version.service';
import { ProductSourceSellerRulesService } from './product-source-seller-rules.service';

/**
 * Who a change is attributed to when the caller did not say.
 *
 * A write that reaches here without an actor came from a code path that has
 * not been taught to pass one; recording it as an unnamed system change is
 * honest, where defaulting it to some user would not be.
 */
const UNATTRIBUTED: ProductSourceActor = systemActor('unattributed');

@Injectable()
export class ProductSourceUpdateService {
  private readonly logger = new CustomLogger(ProductSourceUpdateService.name);

  constructor(
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly sellerRepo: SellerRepository,
    private readonly versionService: ProductSourceVersionService,
    private readonly sellerRules: ProductSourceSellerRulesService,
  ) {}

  public async updateProductSource(
    productSourceId: string,
    params: ProductSourceUpdateParams,
  ): Promise<ProductSource> {
    // The seller relation is loaded so the saved entity we return still carries
    // it — the admin details route serializes it.
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
      relations: { seller: true },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    // `type` is create-only. The two config formats share no keys, so
    // reinterpreting a stored config under a different type reads the wrong
    // ones — and the config validator dispatches on this value, so a flipped
    // type would either fail validation or silently validate the wrong shape.
    // Rejecting a no-op assignment too, so callers that echo the whole entity
    // back don't learn to rely on it being ignored.
    if (params.type !== undefined && params.type !== source.type) {
      throw new BadRequestException(
        `A product source's type cannot be changed (it is "${source.type}"). ` +
          `Create a new source of type "${params.type}" for this seller instead.`,
      );
    }

    if (params.name !== undefined) {
      source.name = params.name.trim();
    }

    // Captured before anything is applied, so the audit rows below can say
    // what a value changed FROM as well as to.
    const previous = {
      seller: source.seller,
      schedulingEnabled: source.schedulingEnabled,
      processingEnabled: source.processingEnabled,
      priority: source.priority,
      identifiesProducts: source.identifiesProducts,
      hasAllProducts: source.hasAllProducts,
    };

    if (params.sellerId !== undefined) {
      const seller = await this.sellerRepo.findById(params.sellerId);
      if (!seller) {
        throw new NotFoundException('Seller not found');
      }

      source.seller = seller;
    }

    if (params.schedulingEnabled !== undefined) {
      source.schedulingEnabled = params.schedulingEnabled;
    }

    if (params.processingEnabled !== undefined) {
      source.processingEnabled = params.processingEnabled;
    }

    if (params.priority !== undefined) {
      source.priority = params.priority;
    }

    if (params.identifiesProducts !== undefined) {
      source.identifiesProducts = params.identifiesProducts;
    }

    if (params.hasAllProducts !== undefined) {
      source.hasAllProducts = params.hasAllProducts;
    }

    if (params.maxConcurrent !== undefined) {
      source.maxConcurrent = params.maxConcurrent;
    }

    if (params.requestsPerHour !== undefined) {
      source.requestsPerHour = params.requestsPerHour;
    }

    if (params.frequency !== undefined) {
      source.frequency = this.parseInterval(
        params.frequency,
        'frequency',
      );
    }

    if (params.detailRefreshInterval !== undefined) {
      source.detailRefreshInterval = this.parseRequiredInterval(
        params.detailRefreshInterval,
        'detailRefreshInterval',
      );
    }

    if (params.nextRunAt !== undefined) {
      source.nextRunAt = this.parseDate(
        params.nextRunAt,
        'nextRunAt',
      );
    }

    await this.assertSellerRules(source, previous);

    try {
      await this.productSourceRepo.save(source);
    } catch (error: unknown) {
      throw this.sellerRules.translateSaveError(error, source.priority);
    }

    const actor = params.actor ?? UNATTRIBUTED;

    // AFTER the save above, and in its own transaction, because addVersion
    // writes source.config itself. Applying the config here as well would mean
    // this save and that one both claiming to set the same column, and the
    // stale instance held here would put the old config back.
    if (params.config !== undefined) {
      const version = await this.versionService.addVersionIfChanged(
        source.id,
        params.config,
        { actor, note: params.configNote },
      );

      if (version) {
        // Reflected onto the instance being returned so the response shows
        // what is now stored rather than what was there when it was loaded.
        source.config = version.config;
      }
    }

    await this.recordFieldActions(source, params, previous, actor);

    // Re-read with the history attached rather than returning the instance we
    // just mutated. The caller's next render is of what is now stored —
    // including the version this save may have written — so the page has no
    // reason to ask again, and no window in which it shows a source whose
    // history is one request out of date.
    return this.versionService.getDetail(source.id);
  }

  /**
   * The rules a seller's sources keep together (ProductSourceSellerRulesService),
   * checked only for what this update changes, so an untouched source is never
   * refused for a state it already had.
   */
  private async assertSellerRules(
    source: ProductSource,
    previous: {
      seller?: Seller;
      priority: number;
      identifiesProducts: boolean;
      hasAllProducts: boolean;
    },
  ): Promise<void> {
    const sellerMoved = previous.seller?.id !== source.seller.id;

    if (source.hasAllProducts !== previous.hasAllProducts) {
      this.sellerRules.assertCompletenessAllowed({
        type: source.type,
        hasAllProducts: source.hasAllProducts,
      });
    }

    if (sellerMoved || source.identifiesProducts !== previous.identifiesProducts) {
      await this.sellerRules.assertKeepsIdentifyingSource({
        next: {
          id: source.id,
          sellerId: source.seller.id,
          identifiesProducts: source.identifiesProducts,
        },
        previousSellerId: previous.seller?.id,
      });
    }

    if (sellerMoved || source.priority !== previous.priority) {
      await this.sellerRules.assertPriorityFree({
        sellerId: source.seller.id,
        priority: source.priority,
        excludingSourceId: source.id,
      });
    }
  }

  /**
   * Writes an audit row for each non-config field that actually changed.
   *
   * Only the ones worth a timeline entry: scheduling and processing decide
   * whether the source runs at all, the seller decides who every future
   * offer belongs to, and the two flags decide whether the source creates
   * products and whether its runs may remove offers. Renaming it or nudging an interval is visible in the row
   * itself and not worth a row of its own.
   *
   * Never fails the update. The change is already committed by the time this
   * runs, and losing an audit row is a smaller problem than reporting a
   * successful save as an error and inviting somebody to repeat it.
   */
  private async recordFieldActions(
    source: ProductSource,
    params: ProductSourceUpdateParams,
    previous: {
      seller?: Seller;
      schedulingEnabled: boolean;
      processingEnabled: boolean;
      identifiesProducts: boolean;
      hasAllProducts: boolean;
    },
    actor: ProductSourceActor,
  ): Promise<void> {
    try {
      if (
        params.schedulingEnabled !== undefined &&
        params.schedulingEnabled !== previous.schedulingEnabled
      ) {
        await this.versionService.recordAction(
          source,
          'scheduling_changed',
          { from: previous.schedulingEnabled, to: source.schedulingEnabled },
          actor,
        );
      }

      if (
        params.processingEnabled !== undefined &&
        params.processingEnabled !== previous.processingEnabled
      ) {
        await this.versionService.recordAction(
          source,
          'processing_changed',
          { from: previous.processingEnabled, to: source.processingEnabled },
          actor,
        );
      }

      if (
        params.identifiesProducts !== undefined &&
        params.identifiesProducts !== previous.identifiesProducts
      ) {
        await this.versionService.recordAction(
          source,
          'identifies_products_changed',
          { from: previous.identifiesProducts, to: source.identifiesProducts },
          actor,
        );
      }

      if (
        params.hasAllProducts !== undefined &&
        params.hasAllProducts !== previous.hasAllProducts
      ) {
        await this.versionService.recordAction(
          source,
          'has_all_products_changed',
          { from: previous.hasAllProducts, to: source.hasAllProducts },
          actor,
        );
      }

      if (params.sellerId !== undefined && previous.seller?.id !== source.seller?.id) {
        await this.versionService.recordAction(
          source,
          'seller_changed',
          {
            from: previous.seller?.id ?? null,
            to: source.seller?.id ?? null,
            // Frozen here rather than joined at render time, so the timeline
            // still names both sellers if either is renamed later.
            fromLabel: previous.seller?.name ?? null,
            toLabel: source.seller?.name ?? null,
          },
          actor,
        );
      }
    } catch (error: unknown) {
      this.logger.warn('Failed to record product source audit action', {
        productSourceId: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Clearing has to resolve to null, not undefined: TypeORM's save() skips
  // undefined properties, so an undefined here would leave the old value in
  // the column instead of wiping it.
  private parseInterval(
    value: string | null,
    fieldName: string,
  ): ms.StringValue | null {
    if (value === null || value.trim() === '') {
      return null;
    }

    const parsedInterval = ms(value as ms.StringValue);
    if (parsedInterval === undefined) {
      throw new BadRequestException(`Invalid ${fieldName} format`);
    }

    return value as ms.StringValue;
  }

  // For an interval the source cannot do without: clearing it is refused
  // rather than read as "never", and so is one that is not a positive span.
  private parseRequiredInterval(value: string | null, fieldName: string): ms.StringValue {
    const interval = this.parseInterval(value, fieldName);
    if (interval === null) {
      throw new BadRequestException(`${fieldName} cannot be cleared`);
    }
    if (ms(interval) <= 0) {
      throw new BadRequestException(`${fieldName} must be a positive interval`);
    }
    return interval.trim() as ms.StringValue;
  }

  // Clearing a next-sync timestamp is meaningful — ProductSourceSyncScheduler
  // reads a NULL as "due on the next tick" — so an empty value maps to null.
  private parseDate(value: string | null, fieldName: string): Date | null {
    if (value === null || value.trim() === '') {
      return null;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid ${fieldName} format`);
    }

    return parsed;
  }
}
