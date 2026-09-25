import { load } from 'cheerio';

/** The parts of a parsed node the walk below reads. */
interface HtmlNode {
  type: string;
  name?: string;
  data?: string;
  children?: HtmlNode[];
}

/** Elements whose content is never text a reader should see. */
const DROPPED_ELEMENTS = new Set([
  'script',
  'style',
  'head',
  'title',
  'meta',
  'link',
  'noscript',
  'template',
  'iframe',
  'svg',
  'xml',
]);

/** Elements that start and end a line of their own. */
const LINE_ELEMENTS = new Set([
  'p',
  'div',
  'li',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tr',
  'table',
  'blockquote',
  'pre',
  'section',
  'article',
  'header',
  'footer',
  'figure',
  'figcaption',
  'address',
  'hr',
]);

const CELL_ELEMENTS = new Set(['td', 'th']);

/** Text that has no tag at all, whose line breaks are its own. */
const HAS_TAG = /<[a-z!/?]/i;

/**
 * A shop's HTML (inline styles, MS-Word markup, possibly scripts) as plain
 * text that is safe however it is rendered.
 *
 * Scripts, styles, the head and comments (MS-Word's `<!--[if gte mso 9]>`
 * blocks among them) are dropped. `<br>` and block elements end a line, list
 * items start with `- `, and an empty paragraph (the way Word spaces text)
 * leaves one blank line. Entities are decoded, whitespace within a line is
 * collapsed, and there is never more than one blank line in a row. Text with
 * no tag at all keeps its own line breaks.
 */
export function htmlToText(html: string): string {
  const source = HAS_TAG.test(html) ? html : html.replace(/\r?\n/g, '<br>');
  const lines: string[] = [];
  let line = '';
  let prefix = '';

  const endLine = (keepEmpty: boolean): void => {
    const text = line.replace(/\s+/g, ' ').trim();
    if (text) {
      lines.push(prefix + text);
      prefix = '';
    } else if (keepEmpty) {
      lines.push('');
    }
    line = '';
  };

  const walk = (node: HtmlNode): void => {
    if (node.type === 'comment' || node.type === 'directive') return;
    if (node.type === 'text') {
      line += node.data ?? '';
      return;
    }

    const name = node.name?.toLowerCase();
    if (name && DROPPED_ELEMENTS.has(name)) return;
    if (name === 'br') {
      endLine(true);
      return;
    }

    const ownLine = name !== undefined && LINE_ELEMENTS.has(name);
    if (ownLine) endLine(false);
    if (name === 'li') prefix = '- ';
    const linesBefore = lines.length;

    for (const child of node.children ?? []) walk(child);

    if (name && CELL_ELEMENTS.has(name)) line += ' ';
    if (ownLine) {
      const empty = lines.length === linesBefore && !line.trim();
      endLine(name === 'p' && empty);
    }
    if (name === 'li') prefix = '';
  };

  walk(load(source, null, false).root()[0]);
  endLine(false);

  return lines
    .filter((text, index) => text || lines[index - 1])
    .join('\n')
    .trim();
}
