/**
 * What a ProductImportTask imports: a scraped list page, a scraped detail
 * page, or one row of an Árukereső feed (its payload is the row itself).
 */
export enum ProductImportTaskKind {
  ListPage = 'list_page',
  DetailPage = 'detail_page',
  FeedEntry = 'feed_entry',
}
