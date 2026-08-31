/** Top-level discriminator for a `ProductResolution` row: which system produced it.
 *  'product_resolution' — the real-time identity-resolution pipeline (`libs/resolution`),
 *  run at scrape time to decide whether a scraped listing matches an existing product.
 *  'duplicate_detection' — the nightly cron / scrape-time safety net that compares
 *  pairs of already-existing catalog products for near-duplicates. */
export enum ProductResolutionFlow {
  product_resolution = 'product_resolution',
  duplicate_detection = 'duplicate_detection',
}
