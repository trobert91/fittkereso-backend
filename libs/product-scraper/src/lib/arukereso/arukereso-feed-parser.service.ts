import { Injectable } from '@nestjs/common';
import { Parser } from 'htmlparser2';
import { Readable } from 'stream';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  ArukeresoFeedItem,
  normalizeFieldName,
} from './arukereso-feed-item';
import {
  parseAttributeFragment,
  unwrapCdata,
} from './arukereso-attributes.parser';
import {
  Delimiter,
  detectDelimiter,
  parseDelimited,
} from './delimited-feed.parser';

export type FeedFormat = 'auto' | 'xml' | 'csv';

export interface ParseFeedOptions {
  format?: FeedFormat;
  delimiter?: 'auto' | Delimiter;
  contentType?: string;
}

/** Called once per product, so a large feed is never held whole. */
export type FeedItemHandler = (item: ArukeresoFeedItem) => void | Promise<void>;

export interface ParseFeedSummary {
  itemsParsed: number;
  /** Attribute pairs dropped for missing a name or a value. */
  attributesSkipped: number;
  format: 'xml' | 'csv';
  delimiter?: Delimiter;
}

const ITEM_ELEMENT = 'product';
const ATTRIBUTES_ELEMENT = 'attributes';
const ATTRIBUTE_ELEMENT = 'attribute';
const ATTRIBUTE_NAME = 'attribute_name';
const ATTRIBUTE_VALUE = 'attribute_value';

/**
 * Turns any supported Árukereső feed into one common item type.
 *
 * Árukereső accepts exactly two format families — XML, and delimited text
 * (CSV/TSV with comma, semicolon or tab) — and specifies attributes as XML in
 * both. This service is the only place that knows which is which; everything
 * downstream sees ArukeresoFeedItem and cannot tell them apart.
 *
 * XML is parsed with htmlparser2's streaming parser, already a dependency via
 * cheerio, so a 26 MB feed is consumed chunk by chunk and never becomes a DOM.
 */
@Injectable()
export class ArukeresoFeedParserService {
  private readonly logger = new CustomLogger(ArukeresoFeedParserService.name);

  /**
   * Parse a feed stream, invoking `onItem` per product.
   *
   * Streaming rather than returning an array: speedbike's feed is 26 MB and
   * 3488 products today, and it only grows.
   */
  public async parseStream(
    stream: Readable,
    onItem: FeedItemHandler,
    opts: ParseFeedOptions = {},
  ): Promise<ParseFeedSummary> {
    const format = await this.resolveFormat(stream, opts);

    return format === 'xml'
      ? this.parseXmlStream(stream, onItem)
      : this.parseDelimitedStream(stream, onItem, opts);
  }

  /** Convenience for tests and small feeds. */
  public async parseString(
    text: string,
    onItem: FeedItemHandler,
    opts: ParseFeedOptions = {},
  ): Promise<ParseFeedSummary> {
    return this.parseStream(Readable.from([text]), onItem, opts);
  }

  /**
   * Decide the format without consuming the stream.
   *
   * Prefers an explicit setting, then the content type, then the first
   * non-whitespace bytes — an XML feed starts with `<?xml` or `<products`,
   * a delimited one with a header row.
   */
  private async resolveFormat(
    stream: Readable,
    opts: ParseFeedOptions,
  ): Promise<'xml' | 'csv'> {
    if (opts.format === 'xml' || opts.format === 'csv') return opts.format;

    const contentType = (opts.contentType ?? '').toLowerCase();
    if (contentType.includes('xml')) return 'xml';
    if (contentType.includes('csv') || contentType.includes('tab-separated')) {
      return 'csv';
    }

    const peeked = await this.peek(stream, 256);
    return peeked.trimStart().startsWith('<') ? 'xml' : 'csv';
  }

  /** Read the first bytes and push them back, so nothing is lost. */
  private async peek(stream: Readable, bytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const onReadable = () => {
        const chunk = stream.read();
        if (chunk === null) return;
        stream.removeListener('readable', onReadable);
        stream.removeListener('error', reject);
        stream.unshift(chunk);
        resolve(Buffer.from(chunk).toString('utf-8').slice(0, bytes));
      };
      const onEnd = () => resolve('');
      stream.once('error', reject);
      stream.once('end', onEnd);
      stream.on('readable', onReadable);
    });
  }

  private async parseXmlStream(
    stream: Readable,
    onItem: FeedItemHandler,
  ): Promise<ParseFeedSummary> {
    let itemsParsed = 0;
    let attributesSkipped = 0;

    // Handlers are synchronous, so items are collected per chunk and awaited
    // between chunks — that keeps onItem's async work from racing the parser
    // while still never holding more than one chunk's worth of products.
    let pending: ArukeresoFeedItem[] = [];

    let current: ArukeresoFeedItem | null = null;
    let field: string | null = null;
    let buffer = '';
    let inAttributes = false;
    let inAttribute = false;
    let attrName: string | null = null;
    let attrValue: string | null = null;

    const parser = new Parser(
      {
        onopentag: (rawName) => {
          const name = rawName.toLowerCase();

          if (name === ITEM_ELEMENT) {
            current = { fields: {}, attributes: [] };
            return;
          }
          if (!current) return;

          if (name === ATTRIBUTES_ELEMENT) {
            inAttributes = true;
            return;
          }
          if (inAttributes && name === ATTRIBUTE_ELEMENT) {
            inAttribute = true;
            attrName = null;
            attrValue = null;
            return;
          }

          field = name;
          buffer = '';
        },

        // CDATA arrives here too — htmlparser2 signals the section with
        // oncdatastart/oncdataend and delivers its content as ordinary text, so
        // the 39,967-character HTML descriptions need no special handling.
        ontext: (text) => {
          if (field) buffer += text;
        },

        onclosetag: (rawName) => {
          const name = rawName.toLowerCase();

          if (name === ITEM_ELEMENT) {
            if (current) {
              pending.push(current);
              itemsParsed += 1;
            }
            current = null;
            return;
          }
          if (!current) return;

          if (name === ATTRIBUTES_ELEMENT) {
            inAttributes = false;
            return;
          }

          if (inAttribute) {
            if (name === ATTRIBUTE_NAME) attrName = unwrapCdata(buffer);
            else if (name === ATTRIBUTE_VALUE) attrValue = unwrapCdata(buffer);
            else if (name === ATTRIBUTE_ELEMENT) {
              // Both halves or neither — see parseAttributeFragment.
              if (attrName && attrValue) {
                current.attributes.push({ name: attrName, value: attrValue });
              } else {
                attributesSkipped += 1;
              }
              inAttribute = false;
            }
            field = null;
            buffer = '';
            return;
          }

          current.fields[normalizeFieldName(name)] = unwrapCdata(buffer);
          field = null;
          buffer = '';
        },
      },
      { xmlMode: true, decodeEntities: true, recognizeCDATA: true },
    );

    for await (const chunk of stream) {
      parser.write(chunk.toString('utf-8'));
      for (const item of pending) await onItem(item);
      pending = [];
    }
    parser.end();
    for (const item of pending) await onItem(item);

    this.logger.debug('Parsed XML feed', { itemsParsed, attributesSkipped });
    return { itemsParsed, attributesSkipped, format: 'xml' };
  }

  /**
   * Parse delimited text.
   *
   * Buffered rather than streamed: a quoted cell may contain newlines, so rows
   * cannot be split on line boundaries without a stateful reader, and the
   * delimited feeds in practice are far smaller than the XML ones. If that
   * stops being true, this is the place to make incremental.
   */
  private async parseDelimitedStream(
    stream: Readable,
    onItem: FeedItemHandler,
    opts: ParseFeedOptions,
  ): Promise<ParseFeedSummary> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf-8');

    const delimiter =
      !opts.delimiter || opts.delimiter === 'auto'
        ? detectDelimiter(text)
        : opts.delimiter;

    const rows = parseDelimited(text, delimiter);
    if (rows.length === 0) {
      return { itemsParsed: 0, attributesSkipped: 0, format: 'csv', delimiter };
    }

    const header = rows[0].map((name) => normalizeFieldName(name));
    const attributesColumn = header.indexOf('attributes');

    let itemsParsed = 0;
    let attributesSkipped = 0;

    for (const row of rows.slice(1)) {
      // A trailing blank line, or a row of empty cells, is not a product.
      if (row.every((cell) => cell.trim() === '')) continue;

      const item: ArukeresoFeedItem = { fields: {}, attributes: [] };

      header.forEach((name, index) => {
        if (index === attributesColumn) return;
        item.fields[name] = (row[index] ?? '').trim();
      });

      if (attributesColumn !== -1) {
        const parsed = parseAttributeFragment(row[attributesColumn] ?? '');
        item.attributes = parsed.attributes;
        attributesSkipped += parsed.skipped;
      }

      itemsParsed += 1;
      await onItem(item);
    }

    this.logger.debug('Parsed delimited feed', {
      itemsParsed,
      attributesSkipped,
      delimiter: delimiter === '\t' ? 'tab' : delimiter,
    });

    return { itemsParsed, attributesSkipped, format: 'csv', delimiter };
  }
}
