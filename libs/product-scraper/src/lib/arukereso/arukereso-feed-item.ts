/**
 * One product from an Árukereső feed, in the single shape every supported
 * format converts to.
 *
 * The whole point of this type: Árukereső accepts XML and delimited text
 * (CSV/TSV with comma, semicolon or tab), and attributes travel as XML in both
 * — so without a common form, every consumer downstream would need to know
 * which format it came from.
 */
export interface ArukeresoFeedItem {
  /**
   * Field values keyed by NORMALIZED name — lowercased with `_`, `-` and
   * spaces stripped.
   *
   * Normalization is not a nicety. At least three spelling families exist in
   * the wild for the same fields: the official PascalCase (`ProductUrl`), the
   * docs' own lowercase CSV headers (`producturl`), and ShopRenter's snake_case
   * (`product_url`). Árukereső renamed its fields in July 2021 and left the old
   * names valid with no published mapping, so a parser that matches literally
   * reads nothing from most real feeds.
   */
  fields: Record<string, string>;

  /**
   * Spec pairs, already trimmed. Pairs missing either half are dropped —
   * measured on speedbike's live feed: 2 of 623 have no name (unusable as a
   * mapping label) and 51 have no value (nothing to record).
   */
  attributes: { name: string; value: string }[];
}

/** Lowercase, strip `_`, `-` and whitespace. The one field-name rule. */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, '');
}

/** Read a field by any spelling of its name. */
export function feedField(
  item: ArukeresoFeedItem,
  name: string,
): string | undefined {
  const value = item.fields[normalizeFieldName(name)];
  return value === undefined || value === '' ? undefined : value;
}
