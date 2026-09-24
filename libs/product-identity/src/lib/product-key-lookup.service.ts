import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { compact, isEmpty, keyBy, uniq, uniqBy } from 'lodash';
import {
  DuplicateDetectedBy,
  DuplicatePairRow,
  OfferRepository,
  ProductDuplicatePairRepository,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecordRepository,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { keyPairRowOf } from './duplicate-pairs';
import { primarySpecMismatches } from './gates';
import type { FailedGate } from './types';

/**
 * The identifiers a listing can be found by, in the order they decide: the
 * sizes its own shop declares as siblings, then its GTIN, then its MPN.
 */
export type IdentifierTier = 'sibling' | 'gtin' | 'mpn';
export const IDENTIFIER_TIERS: readonly IdentifierTier[] = ['sibling', 'gtin', 'mpn'];

/** A stored product one of a listing's identifiers points at. */
export interface KeyMatch {
  via: IdentifierTier;
  /** The value that matched: a sibling's externalId, a GTIN-14 or an MPN. */
  key: string;
  productId: string;
}

/** What a listing can be looked up by. Every value already normalized. */
export interface ListingIdentifiers {
  sourceId: string;
  /** Declared sibling ids, the listing's own id excluded. */
  siblingIds: string[];
  gtins: string[];
  mpns: string[];
  /** The listing's resolved brand. Without one, MPNs are not looked up. */
  brandId?: string;
}

/** The listing side of the sanity check. */
export interface ListingIdentity {
  brandId?: string;
  specs?: ProductSpecs;
  categorySlug: string;
}

export type KeyConflictReason = 'ambiguous' | 'brand_mismatch' | 'spec_mismatch';

/**
 * What the identifier tiers decided: nothing found, a product to attach to, or
 * a conflict that sends the listing on to name matching.
 */
export type KeyVerdict =
  | { kind: 'none' }
  | { kind: 'attach'; via: IdentifierTier; productId: string }
  | {
      kind: 'conflict';
      via: IdentifierTier;
      reason: KeyConflictReason;
      productIds: string[];
    };

export interface KeyDecision {
  verdict: KeyVerdict;
  /**
   * Primary-spec contradictions between the listing and every matched
   * product — the evidence a pair shows its reviewer.
   */
  failedGates: Record<string, FailedGate[]>;
}

/**
 * Identifier lookups for scrape-time identity: finds the products a listing's
 * declared siblings, GTINs and MPNs point at, decides whether the first tier
 * that found one may attach the listing to it, and pairs the listing's product
 * with every other product sharing one of its identifiers.
 *
 * No name scoring here. An identifier either points at a product or it does
 * not; what it cannot say is whether the shop filled it in correctly, which is
 * what the sanity check is for.
 */
@Injectable()
export class ProductKeyLookupService {
  constructor(
    private readonly offerRepo: OfferRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly pairRepo: ProductDuplicatePairRepository,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /** Every product each tier points at, in tier order, one entry per (tier, product). */
  public async lookup(identifiers: ListingIdentifiers): Promise<KeyMatch[]> {
    const { sourceId, brandId } = identifiers;
    const siblingIds = uniq(identifiers.siblingIds);
    const gtins = uniq(identifiers.gtins);
    const mpns = uniq(identifiers.mpns);

    const [siblings, byGtin, byMpn] = await Promise.all([
      this.sourceRecordRepo.findModelIdsBySourceAndExternalIds(sourceId, siblingIds),
      this.offerRepo.findModelIdsByGtins(gtins),
      brandId ? this.offerRepo.findModelIdsByMpns(brandId, mpns) : [],
    ]);

    return this.matchesOf(siblings, byGtin, byMpn);
  }

  /**
   * The pairs `recordPairs` writes when a listing is imported, found again from
   * what this product stores: every other product holding a size one of its
   * listings declared, an offer with one of its offers' GTINs, or one with its
   * MPN within its brand. A complete duplicate scan deletes the open pairs it
   * didn't re-find, so without this every identifier pair would be gone the
   * night after the import that raised it.
   *
   * The gates compare the two stored products, where the import compared the
   * listing with the other product. Expects `brand` and `productCategory`
   * loaded; without a brand no MPN is looked up.
   */
  public async storedPairRows(
    product: ProductModel,
    detectedBy: DuplicateDetectedBy,
  ): Promise<DuplicatePairRow[]> {
    const [offers, declared] = await Promise.all([
      this.offerRepo.find({
        where: { model: { id: product.id } },
        select: { id: true, gtin: true, mpn: true },
      }),
      this.sourceRecordRepo.findDeclaredSiblingIdsOfModel(product.id),
    ]);
    const gtins = uniq(compact(offers.map((offer) => offer.gtin)));
    const mpns = uniq(compact(offers.map((offer) => offer.mpn)));
    const brandId = product.brand?.id;

    const [siblings, byGtin, byMpn] = await Promise.all([
      Promise.all(
        declared.map(({ sourceId, siblingIds }) =>
          this.sourceRecordRepo.findModelIdsBySourceAndExternalIds(
            sourceId,
            uniq(siblingIds),
          ),
        ),
      ).then((rows) => rows.flat()),
      this.offerRepo.findModelIdsByGtins(gtins),
      brandId ? this.offerRepo.findModelIdsByMpns(brandId, mpns) : [],
    ]);

    // A product's own sizes point back at itself.
    const others = this.matchesOf(siblings, byGtin, byMpn).filter(
      (match) => match.productId !== product.id,
    );
    if (isEmpty(others)) return [];

    const otherSpecs = keyBy(
      await this.productRepo.find({
        where: { id: In(uniq(others.map((match) => match.productId))) },
        select: { id: true, specs: true },
      }),
      (other) => other.id,
    );
    const categoryConfig = product.productCategory?.slug
      ? this.categoryConfigService.getConfig(product.productCategory.slug)
      : undefined;

    const failedGates: Record<string, FailedGate[]> = {};
    for (const productId of Object.keys(otherSpecs)) {
      failedGates[productId] = primarySpecMismatches({
        querySpecs: product.specs,
        candidateSpecs: otherSpecs[productId].specs,
        categoryConfig,
      });
    }
    return this.pairRowsOf(product.id, others, failedGates, detectedBy);
  }

  /**
   * The first tier that found anything decides. One product, of the listing's
   * brand, contradicting none of the listing's primary specs: attach. Several
   * products, another brand, or a contradiction (a 2025 bike's GTIN on a 2027
   * listing): a conflict, and the listing goes on to name matching. Later tiers
   * never overrule an earlier one.
   */
  public async decide(
    matches: KeyMatch[],
    listing: ListingIdentity,
  ): Promise<KeyDecision> {
    if (isEmpty(matches)) return { verdict: { kind: 'none' }, failedGates: {} };

    const productIds = uniq(matches.map((match) => match.productId));
    const products = keyBy(
      await this.productRepo.find({
        where: { id: In(productIds) },
        relations: { brand: true },
        select: { id: true, specs: true, brand: { id: true } },
      }),
      (product) => product.id,
    );
    const categoryConfig = this.categoryConfigService.getConfig(listing.categorySlug);

    const failedGates: Record<string, FailedGate[]> = {};
    for (const productId of productIds) {
      failedGates[productId] = primarySpecMismatches({
        querySpecs: listing.specs,
        candidateSpecs: products[productId]?.specs,
        categoryConfig,
      });
    }

    const verdictOf = (via: IdentifierTier): KeyVerdict | undefined => {
      const found = uniq(
        matches.filter((match) => match.via === via).map((match) => match.productId),
      );
      if (isEmpty(found)) return undefined;
      if (found.length > 1) {
        return { kind: 'conflict', via, reason: 'ambiguous', productIds: found };
      }

      const [productId] = found;
      const brandId = products[productId]?.brand?.id;
      if (!listing.brandId || brandId !== listing.brandId) {
        return { kind: 'conflict', via, reason: 'brand_mismatch', productIds: found };
      }
      if (!isEmpty(failedGates[productId])) {
        return { kind: 'conflict', via, reason: 'spec_mismatch', productIds: found };
      }
      return { kind: 'attach', via, productId };
    };

    for (const via of IDENTIFIER_TIERS) {
      const verdict = verdictOf(via);
      if (verdict) return { verdict, failedGates };
    }
    return { verdict: { kind: 'none' }, failedGates };
  }

  /**
   * The tiers that point somewhere other than where the listing was resolved
   * to — only those after `resolvedVia` when an identifier resolved it, every
   * tier when the listing's own history did.
   */
  public disagreeingTiers(
    matches: KeyMatch[],
    productId: string,
    resolvedVia?: IdentifierTier,
  ): IdentifierTier[] {
    const after = resolvedVia ? IDENTIFIER_TIERS.indexOf(resolvedVia) + 1 : 0;
    return IDENTIFIER_TIERS.slice(after).filter((via) =>
      matches.some((match) => match.via === via && match.productId !== productId),
    );
  }

  /**
   * Pairs the product a listing ended up on with every other product sharing
   * one of its identifiers, however it got there: a conflict, a failed sanity
   * check, or a disagreement between tiers. Two products with one GTIN are
   * worth a person's look whichever of them is wrong. Returns the pairs written.
   */
  public async recordPairs(
    productId: string,
    matches: KeyMatch[],
    failedGates: Record<string, FailedGate[]>,
    detectedBy: DuplicateDetectedBy,
  ): Promise<number> {
    const rows = this.pairRowsOf(productId, matches, failedGates, detectedBy);
    if (isEmpty(rows)) return 0;
    return this.pairRepo.upsertPairs(rows);
  }

  /** One match per (tier, product), in tier order. */
  private matchesOf(
    siblings: { externalId: string; modelId: string }[],
    byGtin: { gtin: string; modelId: string }[],
    byMpn: { mpn: string; modelId: string }[],
  ): KeyMatch[] {
    return uniqBy(
      [
        ...siblings.map((row) => this.matchOf('sibling', row.externalId, row.modelId)),
        ...byGtin.map((row) => this.matchOf('gtin', row.gtin, row.modelId)),
        ...byMpn.map((row) => this.matchOf('mpn', row.mpn, row.modelId)),
      ],
      (match) => `${match.via}:${match.productId}`,
    );
  }

  /** A pair row per other product; the first tier wins, as the strongest evidence. */
  private pairRowsOf(
    productId: string,
    matches: KeyMatch[],
    failedGates: Record<string, FailedGate[]>,
    detectedBy: DuplicateDetectedBy,
  ): DuplicatePairRow[] {
    return uniqBy(
      matches.filter((match) => match.productId !== productId),
      (match) => match.productId,
    ).map((match) =>
      keyPairRowOf(productId, match, failedGates[match.productId] ?? [], detectedBy),
    );
  }

  private matchOf(via: IdentifierTier, key: string, productId: string): KeyMatch {
    return { via, key, productId };
  }
}
