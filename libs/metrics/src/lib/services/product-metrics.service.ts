import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  IDENTITY_EXTRACTION_TOTAL,
  IDENTITY_KEY_CONFLICT_TOTAL,
  IDENTITY_KEY_DISAGREEMENT_TOTAL,
  IDENTITY_SPEC_ROWS_MATCHED,
  NEW_PRODUCT_CREATED,
  OFFER_GTIN_TOTAL,
  OFFER_IDENTITY_CONFLICT_TOTAL,
  PRODUCT_ALIAS_CREATED_TOTAL,
  PRODUCT_BRAND_RESOLUTION_FAILED_TOTAL,
  PRODUCT_IMAGE_COPY_TOTAL,
  PRODUCT_IMAGE_CREATED,
  PRODUCT_MATCHED_TOTAL,
  PRODUCT_SOURCE_SPEC_VALIDATION_FAILED_TOTAL,
  PRODUCT_SPEC_VALIDATION_FAILED,
  PRODUCT_UPDATED,
  SCRAPE_RESOLUTION_OUTCOME_TOTAL,
  SPEC_UNIFICATION_TOTAL,
} from '../metric-names';

export type ScrapeResolutionOutcome =
  | 'skipped_no_category'
  /** Path 3: group-level (ProductSourceRecord.externalId) match — only
   *  reached when Path 2 (below) found no variant-level match. */
  | 'external_id_hit'
  /** Path 2: variant-level (Offer.externalId) match — one of this scrape's
   *  own offers' externalIds matched an existing Offer for this seller.
   *  Tried before the group-level match since it's available whenever a
   *  source identifies its listings at all. */
  | 'offer_external_id_hit'
  /** Path 3b: this source already has a record for the listing's page URL. */
  | 'source_url_hit'
  /** A size this source declared as a sibling is already on a product, and
   *  the listing passed the sanity check against it. */
  | 'sibling_hit'
  /** Another offer, at any seller, carries this listing's GTIN. */
  | 'gtin_hit'
  /** Another offer of the same brand carries this listing's MPN. */
  | 'mpn_hit'
  /** Path 4: exactly one candidate scored at or above `ACCEPT_SCORE`. */
  | 'identified'
  /** Path 4: several candidates were close and the LLM picked one. */
  | 'llm_identified'
  /** Path 4 created a new product — nothing was close enough, or the LLM
   *  declined. */
  | 'created'
  /** Path 4's LLM looked at near-miss candidates and was not confident enough
   *  to attach, so a new product was created. Distinct from nothing being
   *  close enough to be worth asking, which costs no call at all — this
   *  measures how often scoring leaves the LLM undecided. */
  | 'llm_declined';

/**
 * How two things came to claim one offer identity.
 *
 * All three end the same way — one Offer row where there should be several, or
 * a listing bound to the wrong product — and none of them throws.
 */
export type OfferIdentityConflictKind =
  /** Two sources resolved DIFFERENT ProductModels for one (seller, externalId). */
  | 'model_disagreement'
  /** One page yielded several offers sharing a source-native externalId. */
  | 'duplicate_external_id'
  /** One page yielded several offers whose URL slug fallback collided. */
  | 'duplicate_slug_fallback';

/** How a listing's identity was resolved before name matching, for the disagreement metric. */
export type IdentityResolvedVia =
  | 'pinned'
  | 'offer_external_id'
  | 'external_id'
  | 'source_url'
  | 'sibling'
  | 'gtin'
  | 'mpn';

/** What happened to one listing's identity extraction. */
export type IdentityExtractionResult = 'extracted' | 'reused' | 'failed' | 'disabled';

/**
 * Why a product's spec unification ran: it was created, a source first
 * contributed, or an admin forced a resync of one listing.
 */
export type SpecUnificationTrigger = 'created' | 'new_source' | 'forced';

/** What normalizeGtin made of one scraped offer's barcode. */
export type OfferGtinResult = 'valid' | 'invalid' | 'absent';

@Injectable()
export class ProductMetricsService {
  private readonly newProductCounter: client.Counter<string>;
  private readonly productUpdatedCounter: client.Counter<string>;
  private readonly productImageCreatedCounter: client.Counter<string>;
  private readonly productSpecValidationFailedCounter: client.Counter<string>;
  private readonly productMatchedCounter: client.Counter<string>;
  private readonly productAliasCreatedCounter: client.Counter<string>;
  private readonly productBrandResolutionFailedCounter: client.Counter<string>;
  private readonly productSourceSpecValidationFailedCounter: client.Counter<string>;
  private readonly productImageCopyCounter: client.Counter<string>;
  private readonly scrapeResolutionOutcomeCounter: client.Counter<string>;
  private readonly offerIdentityConflictCounter: client.Counter<string>;
  private readonly offerGtinCounter: client.Counter<string>;
  private readonly identityKeyConflictCounter: client.Counter<string>;
  private readonly identityKeyDisagreementCounter: client.Counter<string>;
  private readonly identityExtractionCounter: client.Counter<string>;
  private readonly identitySpecRowsHistogram: client.Histogram<string>;
  private readonly specUnificationCounter: client.Counter<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.newProductCounter = new client.Counter({
      name: NEW_PRODUCT_CREATED,
      help: 'Total number of new products created',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productUpdatedCounter = new client.Counter({
      name: PRODUCT_UPDATED,
      help: 'Total number of products updated',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productImageCreatedCounter = new client.Counter({
      name: PRODUCT_IMAGE_CREATED,
      help: 'Total number of product images created',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productSpecValidationFailedCounter = new client.Counter({
      name: PRODUCT_SPEC_VALIDATION_FAILED,
      help: 'Total number of product spec validation failures',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productMatchedCounter = new client.Counter({
      name: PRODUCT_MATCHED_TOTAL,
      help: 'Total existing products matched during scraping',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productAliasCreatedCounter = new client.Counter({
      name: PRODUCT_ALIAS_CREATED_TOTAL,
      help: 'Total new product aliases created from scraping',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productBrandResolutionFailedCounter = new client.Counter({
      name: PRODUCT_BRAND_RESOLUTION_FAILED_TOTAL,
      help: 'Total brand identification failures during scraping',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productSourceSpecValidationFailedCounter = new client.Counter({
      name: PRODUCT_SOURCE_SPEC_VALIDATION_FAILED_TOTAL,
      help: 'Total per-source spec validation failures',
      labelNames: ['source', 'category'],
      registers: [this.prometheusService.register],
    });
    this.productImageCopyCounter = new client.Counter({
      name: PRODUCT_IMAGE_COPY_TOTAL,
      help: 'Total image copy operations by outcome',
      labelNames: ['source', 'status'],
      registers: [this.prometheusService.register],
    });
    this.scrapeResolutionOutcomeCounter = new client.Counter({
      name: SCRAPE_RESOLUTION_OUTCOME_TOTAL,
      help: 'Total scrape resolution outcomes by result and source',
      labelNames: ['source', 'result'],
      registers: [this.prometheusService.register],
    });
    this.offerIdentityConflictCounter = new client.Counter({
      name: OFFER_IDENTITY_CONFLICT_TOTAL,
      help: 'Offers whose identity collided with another, by kind and source',
      labelNames: ['source', 'kind'],
      registers: [this.prometheusService.register],
    });
    this.offerGtinCounter = new client.Counter({
      name: OFFER_GTIN_TOTAL,
      help: 'Scraped offer GTINs by whether they validated, by source',
      labelNames: ['source', 'result'],
      registers: [this.prometheusService.register],
    });
    this.identityKeyConflictCounter = new client.Counter({
      name: IDENTITY_KEY_CONFLICT_TOTAL,
      help: 'Listings an identifier matched but could not attach, by tier and reason',
      labelNames: ['source', 'via', 'reason'],
      registers: [this.prometheusService.register],
    });
    this.identityKeyDisagreementCounter = new client.Counter({
      name: IDENTITY_KEY_DISAGREEMENT_TOTAL,
      help: 'Listings whose later identifier tiers point at another product than the one resolved',
      labelNames: ['source', 'resolved_via', 'via'],
      registers: [this.prometheusService.register],
    });
    this.identityExtractionCounter = new client.Counter({
      name: IDENTITY_EXTRACTION_TOTAL,
      help: 'Listing identity extractions by result and source',
      labelNames: ['source', 'result'],
      registers: [this.prometheusService.register],
    });
    this.identitySpecRowsHistogram = new client.Histogram({
      name: IDENTITY_SPEC_ROWS_MATCHED,
      help: 'Spec-table rows the identity extraction received per listing, for sources with a row list',
      labelNames: ['source'],
      buckets: [0, 1, 2, 4, 8, 12, 20, 40],
      registers: [this.prometheusService.register],
    });
    this.specUnificationCounter = new client.Counter({
      name: SPEC_UNIFICATION_TOTAL,
      help: 'Full spec unification runs by trigger, result and source',
      labelNames: ['source', 'trigger', 'result'],
      registers: [this.prometheusService.register],
    });
  }

  newProductCreated(source: string): void {
    this.newProductCounter.inc({ source });
  }

  productUpdated(source: string): void {
    this.productUpdatedCounter.inc({ source });
  }

  productImagesCreated(source: string, numberOfImages: number): void {
    this.productImageCreatedCounter.inc({ source }, numberOfImages);
  }

  productSpecValidationFailed(source: string): void {
    this.productSpecValidationFailedCounter.inc({ source });
  }

  productMatched(source: string): void {
    this.productMatchedCounter.inc({ source });
  }

  productAliasCreated(source: string, count: number): void {
    this.productAliasCreatedCounter.inc({ source }, count);
  }

  productBrandResolutionFailed(source: string): void {
    this.productBrandResolutionFailedCounter.inc({ source });
  }

  productSourceSpecValidationFailed(source: string, category: string): void {
    this.productSourceSpecValidationFailedCounter.inc({ source, category });
  }

  productImageCopySuccess(source: string, count: number): void {
    this.productImageCopyCounter.inc({ source, status: 'success' }, count);
  }

  productImageCopyFailed(source: string): void {
    this.productImageCopyCounter.inc({ source, status: 'failed' });
  }

  scrapeResolutionOutcome(
    source: string,
    result: ScrapeResolutionOutcome,
  ): void {
    this.scrapeResolutionOutcomeCounter.inc({ source, result });
  }

  offerIdentityConflict(source: string, kind: OfferIdentityConflictKind): void {
    this.offerIdentityConflictCounter.inc({ source, kind });
  }

  offerGtin(source: string, result: OfferGtinResult): void {
    this.offerGtinCounter.inc({ source, result });
  }

  identityKeyConflict(
    source: string,
    via: 'sibling' | 'gtin' | 'mpn',
    reason: 'ambiguous' | 'brand_mismatch' | 'spec_mismatch',
  ): void {
    this.identityKeyConflictCounter.inc({ source, via, reason });
  }

  identityKeyDisagreement(
    source: string,
    resolvedVia: IdentityResolvedVia,
    via: 'sibling' | 'gtin' | 'mpn',
  ): void {
    this.identityKeyDisagreementCounter.inc({ source, resolved_via: resolvedVia, via });
  }

  identityExtraction(source: string, result: IdentityExtractionResult): void {
    this.identityExtractionCounter.inc({ source, result });
  }

  identitySpecRowsMatched(source: string, rows: number): void {
    this.identitySpecRowsHistogram.observe({ source }, rows);
  }

  specUnification(
    source: string,
    trigger: SpecUnificationTrigger,
    result: 'ok' | 'failed' | 'disabled',
  ): void {
    this.specUnificationCounter.inc({ source, trigger, result });
  }
}
