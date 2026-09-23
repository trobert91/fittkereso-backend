import * as fs from 'fs';
import * as path from 'path';
import { ArukeresoFeedParserService } from './arukereso-feed-parser.service';
import { ArukeresoFeedItem, feedField } from './arukereso-feed-item';

const FIXTURES = path.join(__dirname, '__fixtures__');
const read = (name: string) =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('ArukeresoFeedParserService', () => {
  let parser: ArukeresoFeedParserService;

  const collect = async (text: string, opts = {}) => {
    const items: ArukeresoFeedItem[] = [];
    const summary = await parser.parseString(text, (i) => void items.push(i), opts);
    return { items, summary };
  };

  beforeEach(() => {
    parser = new ArukeresoFeedParserService();
  });

  // The claim this whole service exists to make good on.
  describe('every supported format converts to one common type', () => {
    it('produces identical items from XML, CSV and TSV', async () => {
      const xml = await collect(read('speedbike-feed-sample.xml'));
      const csv = await collect(read('speedbike-feed-sample.csv'));
      const tsv = await collect(read('speedbike-feed-sample.tsv'));

      expect(xml.items).toHaveLength(22);
      expect(csv.items).toHaveLength(22);
      expect(tsv.items).toHaveLength(22);

      expect(xml.summary.format).toBe('xml');
      expect(csv.summary.format).toBe('csv');
      expect(csv.summary.delimiter).toBe(';');
      expect(tsv.summary.delimiter).toBe('\t');

      for (let i = 0; i < xml.items.length; i += 1) {
        const id = feedField(xml.items[i], 'identifier');

        // Attributes must match exactly — they are the spec table.
        expect(csv.items[i].attributes).toEqual(xml.items[i].attributes);
        expect(tsv.items[i].attributes).toEqual(xml.items[i].attributes);

        for (const field of [
          'identifier', 'sku', 'ean_code', 'manufacturer', 'name',
          'category', 'product_url', 'price', 'net_price', 'image_url',
        ]) {
          expect(`${id}.${field}=${feedField(csv.items[i], field)}`).toBe(
            `${id}.${field}=${feedField(xml.items[i], field)}`,
          );
          expect(`${id}.${field}=${feedField(tsv.items[i], field)}`).toBe(
            `${id}.${field}=${feedField(xml.items[i], field)}`,
          );
        }
      }
    });

    // The one intended asymmetry, documented in the fixtures' README: the docs
    // permit TSV to flatten tabs and newlines inside fields to spaces, which is
    // what makes TSV simpler to emit. XML and CSV stay byte-identical.
    it('keeps descriptions identical between XML and CSV', async () => {
      const xml = await collect(read('speedbike-feed-sample.xml'));
      const csv = await collect(read('speedbike-feed-sample.csv'));

      for (let i = 0; i < xml.items.length; i += 1) {
        expect(feedField(csv.items[i], 'description')).toBe(
          feedField(xml.items[i], 'description'),
        );
      }
    });
  });

  describe('field-name normalization', () => {
    // Three spellings of the same field exist in the wild, and the fixtures use
    // a different one per format on purpose. Without normalization a parser
    // reads nothing from two of the three.
    it('reads a field by any of its spellings', async () => {
      const { items } = await collect(read('speedbike-feed-sample.xml'));

      const url = feedField(items[0], 'product_url');
      expect(url).toBeDefined();
      expect(feedField(items[0], 'ProductUrl')).toBe(url);
      expect(feedField(items[0], 'producturl')).toBe(url);
      expect(feedField(items[0], 'PRODUCT-URL')).toBe(url);
    });

    it('treats an empty field as absent', async () => {
      const { items } = await collect(read('speedbike-feed-sample.xml'));

      // No tag is ever missing in this feed — empty fields are emitted as
      // empty elements — so callers must test the value, not tag presence.
      const noSku = items.find((i) => !feedField(i, 'sku'));
      expect(noSku).toBeDefined();
      expect(noSku!.fields['sku']).toBe('');
    });
  });

  describe('XML specifics', () => {
    it('keeps a large CDATA description intact across stream chunks', async () => {
      const { items } = await collect(read('speedbike-feed-sample.xml'));

      const longest = items
        .map((i) => feedField(i, 'description') ?? '')
        .sort((a, b) => b.length - a.length)[0];

      expect(longest.length).toBeGreaterThan(30_000);
      // Raw shop HTML, including MS-Word conditional markup.
      expect(longest).toContain('<p>');
    });

    it('trims whitespace-padded attribute values', async () => {
      const { items } = await collect(read('speedbike-feed-sample.xml'));

      const all = items.flatMap((i) => i.attributes);
      expect(all.length).toBeGreaterThan(500);
      expect(all.every((a) => a.value === a.value.trim())).toBe(true);
      expect(all.every((a) => a.name === a.name.trim())).toBe(true);
    });

    it('drops attribute pairs missing a half, and counts them', async () => {
      const { items, summary } = await collect(read('speedbike-feed-sample.xml'));

      // Measured on this fixture: 2 pairs have no name, 51 have no value.
      expect(summary.attributesSkipped).toBe(53);
      expect(items.flatMap((i) => i.attributes)).toHaveLength(570);
    });

    it('handles a product with no attributes element at all', async () => {
      const { items } = await collect(read('speedbike-feed-sample.xml'));

      expect(items.filter((i) => i.attributes.length === 0)).toHaveLength(2);
    });
  });

  describe('delimited specifics', () => {
    it('accepts both quote-escape styles the docs allow', async () => {
      const doubled = `"name";"note"\r\n"A";"say ""hi"" now"\r\n`;
      const backslash = `"name";"note"\r\n"A";"say \\"hi\\" now"\r\n`;

      const a = await collect(doubled, { format: 'csv' as const });
      const b = await collect(backslash, { format: 'csv' as const });

      expect(feedField(a.items[0], 'note')).toBe('say "hi" now');
      expect(feedField(b.items[0], 'note')).toBe('say "hi" now');
    });

    it('keeps a delimiter that sits inside a quoted field', async () => {
      const csv = `"name";"category"\r\n"A";"Bikes; and more"\r\n`;
      const { items } = await collect(csv, { format: 'csv' as const });

      expect(feedField(items[0], 'category')).toBe('Bikes; and more');
    });

    it('keeps a newline inside a quoted field as one row', async () => {
      const csv = `"name";"description"\r\n"A";"line one\nline two"\r\n`;
      const { items } = await collect(csv, { format: 'csv' as const });

      expect(items).toHaveLength(1);
      expect(feedField(items[0], 'description')).toBe('line one\nline two');
    });

    it('ignores a trailing newline rather than emitting a blank product', async () => {
      const csv = `"name"\r\n"A"\r\n"B"\r\n`;
      const { items } = await collect(csv, { format: 'csv' as const });

      expect(items).toHaveLength(2);
    });
  });

  describe('format detection', () => {
    it('sniffs XML from the leading bytes', async () => {
      const { summary } = await collect(read('speedbike-feed-sample.xml'));
      expect(summary.format).toBe('xml');
    });

    it('sniffs delimited text from the leading bytes', async () => {
      const { summary } = await collect(read('speedbike-feed-sample.csv'));
      expect(summary.format).toBe('csv');
    });

    it('prefers an explicit format over sniffing', async () => {
      const { summary } = await collect(read('speedbike-feed-sample.csv'), {
        format: 'csv' as const,
      });
      expect(summary.format).toBe('csv');
    });

    it('detects semicolon, comma and tab delimiters', async () => {
      const semi = await collect(`"a";"b"\r\n"1";"2"\r\n`, { format: 'csv' as const });
      const comma = await collect(`"a","b"\r\n"1","2"\r\n`, { format: 'csv' as const });
      const tab = await collect(`"a"\t"b"\r\n"1"\t"2"\r\n`, { format: 'csv' as const });

      expect(semi.summary.delimiter).toBe(';');
      expect(comma.summary.delimiter).toBe(',');
      expect(tab.summary.delimiter).toBe('\t');
    });
  });
});
