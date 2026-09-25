import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ProductSource,
  ProductSourceRepository,
  ProductSourceType,
  isFeedSourceType,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty, minBy } from 'lodash';
import { QueryFailedError } from 'typeorm';

/** A seller's first source, when the caller names no priority. */
export const FIRST_SOURCE_PRIORITY = 10;

/** How far below the seller's lowest priority a later source lands by default. */
const PRIORITY_STEP = 10;

/** The intended state of one source, as a create or an update would leave it. */
export interface SellerSourceState {
  /** Undefined for a source not created yet. */
  id?: string;
  sellerId: string;
  identifiesProducts: boolean;
}

/**
 * The rules a seller's set of sources must keep, checked by the create and
 * update paths alike:
 * - priorities are unique per seller, since a higher one overwrites a lower one
 *   field by field and a tie would leave the winner to arrival order;
 * - a seller with sources keeps at least one that identifies products, or
 *   nothing could ever create its offers;
 * - only a feed source may claim to list the whole catalog.
 */
@Injectable()
export class ProductSourceSellerRulesService {
  constructor(private readonly productSourceRepo: ProductSourceRepository) {}

  /**
   * The priority a new source gets when none is given: 10 for a seller's first
   * source, else 10 below the seller's lowest, so a later source only fills
   * gaps. Below 0, the first free value counting up from 0.
   */
  public async defaultPriority(sellerId: string): Promise<number> {
    const taken = await this.prioritiesOf(sellerId);
    const lowest = minBy(taken, (priority) => priority);
    if (lowest === undefined) return FIRST_SOURCE_PRIORITY;

    const below = lowest - PRIORITY_STEP;
    if (below >= 0) return below;

    let free = 0;
    while (taken.includes(free)) free += 1;
    return free;
  }

  public async assertPriorityFree(params: {
    sellerId: string;
    priority: number;
    excludingSourceId?: string;
  }): Promise<void> {
    const holder = await this.productSourceRepo.findOne({
      where: { seller: { id: params.sellerId }, priority: params.priority },
      select: { id: true, name: true },
    });
    if (holder && holder.id !== params.excludingSourceId) {
      throw this.priorityTaken(params.priority, holder.name);
    }
  }

  /**
   * A save that lost a race for the priority fails on the unique
   * `(seller, priority)` index; it is reported as the same error the check
   * above gives. Any other error is returned as it is.
   */
  public translateSaveError(error: unknown, priority: number): unknown {
    if (!(error instanceof QueryFailedError)) return error;
    const detail: unknown = (error.driverError as { detail?: unknown }).detail;
    return typeof detail === 'string' && detail.includes('priority')
      ? this.priorityTaken(priority)
      : error;
  }

  private priorityTaken(priority: number, holderName?: string): BadRequestException {
    const holder = holderName ? `"${holderName}"` : 'another source';
    return new BadRequestException(
      `Priority ${priority} is already used by ${holder} of this seller. ` +
        'A seller\'s sources need distinct priorities: the higher one overwrites the lower one field by field.',
    );
  }

  /**
   * Refuses a change that would leave a seller with sources but none that
   * identifies products. `next` is the source as the change would leave it;
   * pass the seller it leaves as `previousSellerId` when a source moves.
   */
  public async assertKeepsIdentifyingSource(params: {
    next: SellerSourceState;
    previousSellerId?: string;
  }): Promise<void> {
    const { next, previousSellerId } = params;
    const sellerIds = [next.sellerId];
    if (previousSellerId && previousSellerId !== next.sellerId) {
      sellerIds.push(previousSellerId);
    }

    for (const sellerId of sellerIds) {
      const others = (await this.sourcesOf(sellerId)).filter(
        (source) => source.id !== next.id,
      );
      const remaining = [
        ...others.map((source) => source.identifiesProducts),
        ...(next.sellerId === sellerId ? [next.identifiesProducts] : []),
      ];
      if (!isEmpty(remaining) && !remaining.includes(true)) {
        throw new BadRequestException(
          next.sellerId === sellerId && !next.identifiesProducts
            ? 'A seller needs at least one source that identifies products: turn identification on for another of its sources first.'
            : 'Moving this source would leave its seller with no source that identifies products.',
        );
      }
    }
  }

  public assertCompletenessAllowed(params: {
    type: ProductSourceType;
    hasAllProducts: boolean;
  }): void {
    if (params.hasAllProducts && !isFeedSourceType(params.type)) {
      throw new BadRequestException(
        `Only a feed source can list the whole catalog (hasAllProducts); a "${params.type}" run has no single end to decide what is missing.`,
      );
    }
  }

  private async prioritiesOf(sellerId: string): Promise<number[]> {
    return (await this.sourcesOf(sellerId)).map((source) => source.priority);
  }

  private sourcesOf(sellerId: string): Promise<ProductSource[]> {
    return this.productSourceRepo.find({
      where: { seller: { id: sellerId } },
      select: {
        id: true,
        name: true,
        priority: true,
        identifiesProducts: true,
      },
      order: { [nameOf<ProductSource>('priority')]: 'DESC' },
    });
  }
}
