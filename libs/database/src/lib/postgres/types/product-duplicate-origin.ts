/** Distinguishes how a `ProductDuplicate` pair was discovered.
 *  'nightly_detection' — found post-hoc by the nightly `DuplicateDetectionScheduler`
 *  cron comparing already-created `ProductModel`s against each other.
 *  'scrape_time' — flagged live during scraping, when a newly-scraped
 *  listing's identity resolution came back ambiguous (the deterministic
 *  matcher rejected every candidate, but the scrape-merge LLM decision still
 *  found a close-but-not-confident candidate). The new `ProductModel` this
 *  scrape created is `productA`/`productB`'s "new" side. */
export enum ProductDuplicateOrigin {
  scrape_time = 'scrape_time',
  nightly_detection = 'nightly_detection',
}
