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

    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
      i += 1;
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      sawAnyChar = true;
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      const isCrLf = ch === '\r' && text[i + 1] === '\n';
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
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
