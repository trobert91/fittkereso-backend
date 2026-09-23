/**
 * Parses an `<attribute>` fragment into spec pairs.
 *
 * Shared by both format branches, because Árukereső specifies attributes as XML
 * regardless of the feed's own format: in XML they nest under `<Attributes>`,
 * and in CSV/TSV the same fragment sits inside one `Attributes` column with the
 * wrapper element omitted. One parser, fed from either side, is what keeps the
 * two branches producing identical output.
 *
 * Tag names are matched case-insensitively — the docs use `Attribute_name`,
 * their own CSV example uses `attribute_name`, and ShopRenter emits lowercase.
 */
export interface ParsedAttributes {
  attributes: { name: string; value: string }[];
  /** Pairs dropped for missing a name or a value. Worth surfacing, not hiding. */
  skipped: number;
}

const OPEN = '<attribute>';
const CLOSE = '</attribute>';

export function parseAttributeFragment(fragment: string): ParsedAttributes {
  const attributes: { name: string; value: string }[] = [];
  let skipped = 0;

  if (!fragment) return { attributes, skipped };

  const haystack = fragment.toLowerCase();
  let cursor = 0;

  for (;;) {
    const open = haystack.indexOf(OPEN, cursor);
    if (open === -1) break;

    const close = haystack.indexOf(CLOSE, open);
    if (close === -1) break;

    const inner = fragment.slice(open + OPEN.length, close);

    const name = readTag(inner, 'attribute_name');
    const value = readTag(inner, 'attribute_value');

    // Both halves or nothing: a pair with no name cannot match a specMapping
    // label, and one with no value has nothing to record.
    if (name && value) attributes.push({ name, value });
    else skipped += 1;

    cursor = close + CLOSE.length;
  }

  return { attributes, skipped };
}

function readTag(source: string, tag: string): string {
  const haystack = source.toLowerCase();
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  const start = haystack.indexOf(open);
  if (start === -1) return '';

  const end = haystack.indexOf(close, start);
  if (end === -1) return '';

  return unwrapCdata(source.slice(start + open.length, end));
}

/**
 * Strip a CDATA wrapper and trim.
 *
 * Trimming is load-bearing rather than cosmetic: 70,482 of 121,428 attribute
 * values on speedbike's live feed (58%) carry leading whitespace, and an
 * untrimmed value fails every specMapping value comparison.
 */
export function unwrapCdata(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>')) {
    return trimmed.slice(9, -3).trim();
  }
  return trimmed;
}
