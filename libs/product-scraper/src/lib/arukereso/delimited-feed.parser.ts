/**
 * CSV/TSV parsing for Árukereső feeds.
 *
 * Hand-rolled rather than a dependency because the accepted grammar is narrow
 * and fully specified — three delimiters, two quote-escape styles — and a
 * general CSV library would still need configuring for both escape styles,
 * which most do not support simultaneously.
 *
 * Handles: quoted fields containing the delimiter or newlines, doubled quotes
 * (`""x""`), backslash-escaped quotes (`\"x\"`), and CRLF or LF line endings.
 *
 * A quote opens a quoted field only at the start of a cell, as in RFC 4180;
 * anywhere else it is text. Google Shopping's TSV quotes nothing, and its
 * descriptions are full of inch marks (`29" / 27,5"`): a quote opening a field
 * mid-cell swallowed the tabs and line breaks up to the next one, merging and
 * shifting rows.
 */

export type Delimiter = ',' | ';' | '\t';

/**
 * Detect the delimiter from the header line.
 *
 * Counts occurrences OUTSIDE quotes — a header like `"name";"category > sub"`
 * would otherwise let a comma inside a quoted value win.
 */
export function detectDelimiter(sample: string): Delimiter {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? '';

  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;

  for (let i = 0; i < firstLine.length; i += 1) {
    const ch = firstLine[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === ',' || ch === ';' || ch === '\t') counts[ch] += 1;
  }

  // Tab first: a tab-delimited file rarely contains stray semicolons, while a
  // semicolon-delimited one often contains commas inside prose fields.
  if (counts['\t'] > 0) return '\t';
  if (counts[';'] >= counts[',']) return counts[';'] > 0 ? ';' : ',';
  return ',';
}

/**
 * Split delimited text into rows of raw cell values.
 *
 * Returns every row including the header; the caller decides what the first row
 * means.
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  /** Whether the current cell began with a quote, which only it may. */
  let quotedCell = false;
  let sawAnyChar = false;

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      // Both escape styles the docs accept.
      if (ch === '\\' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && cell === '' && !quotedCell) {
      inQuotes = true;
      quotedCell = true;
      sawAnyChar = true;
      i += 1;
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      quotedCell = false;
      sawAnyChar = true;
      i += 1;
      continue;
    }

    // A lone CR is text: Google's descriptions carry a few, mid-sentence.
    const isCrLf = ch === '\r' && text[i + 1] === '\n';
    if (ch === '\n' || isCrLf) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      quotedCell = false;
      sawAnyChar = false;
      i += isCrLf ? 2 : 1;
      continue;
    }

    cell += ch;
    sawAnyChar = true;
    i += 1;
  }

  // A trailing newline must not produce a phantom empty row.
  if (sawAnyChar || cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}
