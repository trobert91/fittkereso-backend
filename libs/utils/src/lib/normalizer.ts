export const normalize = (input: string): string => {
  if (!input) return '';

  return input.toLowerCase().replace(/\s+/g, ' ').trim();
};

// ─── sanitizeText ────────────────────────────────────────────────────────────
//
// Each rewrite group is described by its target ASCII output and the list of
// codepoints it folds. Keeping them as numeric arrays avoids embedding
// invisible/exotic Unicode characters in the source — easy to review, easy to
// extend, and lints cleanly.

interface CharFold {
  /** ASCII replacement (may be multi-character: '--', '...'). */
  replacement: string;
  /** Codepoints (or [start, end] inclusive ranges) to fold to `replacement`. */
  codepoints: ReadonlyArray<number | readonly [number, number]>;
}

const CHAR_FOLDS: ReadonlyArray<CharFold> = [
  // Single quotes: U+2018 left, U+2019 right, U+201A low-9, U+201B reversed-9, U+2032 prime
  { replacement: "'", codepoints: [0x2018, 0x2019, 0x201a, 0x201b, 0x2032] },
  // Double quotes: U+201C left, U+201D right, U+201E low-9, U+201F reversed-9,
  //                U+2033 double-prime, U+00AB / U+00BB guillemets
  {
    replacement: '"',
    codepoints: [0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb],
  },
  // Em dash (U+2014), horizontal bar (U+2015) -> '--'
  { replacement: '--', codepoints: [0x2014, 0x2015] },
  // Hyphen (U+2010), non-breaking hyphen (U+2011), en dash (U+2013), minus sign (U+2212) -> '-'
  { replacement: '-', codepoints: [0x2010, 0x2011, 0x2013, 0x2212] },
  // Ellipsis (U+2026) -> '...'
  { replacement: '...', codepoints: [0x2026] },
  // Line / paragraph separator (U+2028 / U+2029) -> newline
  { replacement: '\n', codepoints: [0x2028, 0x2029] },
  // Exotic spaces -> ASCII space:
  //   U+00A0 NBSP, U+1680 ogham, U+2000-U+200A en/em/thin/hair/punct/figure spaces,
  //   U+202F narrow-NBSP, U+205F medium math space, U+3000 ideographic space
  {
    replacement: ' ',
    codepoints: [0x00a0, 0x1680, [0x2000, 0x200a], 0x202f, 0x205f, 0x3000],
  },
  // Zero-width / formatting chars -> strip:
  //   U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM,
  //   U+00AD soft-hyphen, U+200E LRM, U+200F RLM
  {
    replacement: '',
    codepoints: [0x200b, 0x200c, 0x200d, 0xfeff, 0x00ad, 0x200e, 0x200f],
  },
];

function buildCharClassRegex(
  codepoints: ReadonlyArray<number | readonly [number, number]>,
): RegExp {
  const escapeForCharClass = (cp: number): string => {
    // Always emit \uXXXX so the source contains no invisible glyphs.
    return '\\u' + cp.toString(16).padStart(4, '0');
  };
  const body = codepoints
    .map((entry) =>
      Array.isArray(entry)
        ? `${escapeForCharClass(entry[0])}-${escapeForCharClass(entry[1])}`
        : escapeForCharClass(entry as number),
    )
    .join('');
  return new RegExp(`[${body}]`, 'g');
}

const COMPILED_FOLDS: ReadonlyArray<{
  re: RegExp;
  replacement: string;
}> = CHAR_FOLDS.map((fold) => ({
  re: buildCharClassRegex(fold.codepoints),
  replacement: fold.replacement,
}));

// Markdown backslash escapes — Reddit users escape *_~`[]()#+-.!>
// Inside a character class `[`, `]`, `(`, `)`, `-` (when last) need no escape.
const MARKDOWN_ESCAPE_RE = /\\([*_~`[\]()#+\-!.>])/g;

/**
 * Canonicalize free-text content (Reddit comment bodies, thread OPs) at ingest:
 * - NFC-normalize combining sequences (decomposed e + U+0301 -> precomposed é)
 * - Fold typographic quotes to ASCII (curly ' " -> straight)
 * - Fold em/en/figure dashes and ellipsis to ASCII
 * - Replace exotic whitespace (NBSP, narrow-NBSP, ideographic space, line/paragraph
 *   separator) with regular space / newline; strip zero-width characters
 * - Strip markdown backslash escapes (`\*` -> `*`, `\_` -> `_`)
 *
 * Preserves casing, newlines, and all non-targeted characters. Idempotent.
 *
 * Intended to run ONCE at the ingest boundary (Reddit fetch -> CommentNode /
 * Thread.text) so all downstream consumers (LLM extraction, validation,
 * verbatim detection, relevance) see canonical text.
 */
export const sanitizeText = (input: string | null | undefined): string => {
  if (!input) return input ?? '';

  let result = input.normalize('NFC');
  for (const fold of COMPILED_FOLDS) {
    result = result.replace(fold.re, fold.replacement);
  }
  result = result.replace(MARKDOWN_ESCAPE_RE, '$1');
  return result;
};

/**
 * Collapse whitespace between letter-groups and digit-groups in model numbers.
 * "MPG 341CQPX" → "MPG341CQPX", "UltraGear 34GS95QE" stays as-is (word boundary preserved).
 */
export const normalizeModelName = (input: string): string => {
  if (!input) return '';

  return input
    .replace(/([A-Za-z])\s+(\d)/g, '$1$2') // "MPG 341" → "MPG341"
    .replace(/(\d)\s+([A-Za-z])/g, '$1$2'); // "341 CQPX" → "341CQPX"
};

/**
 * Sanitizes product names by removing marketing terms, brackets, and cleaning artifacts.
 * Preserves model number hyphens while removing marketing suffix hyphens.
 *
 * @example
 * sanitizeName('MSI MPG-341CQPX-QD-OLED') // => 'MSI MPG-341CQPX'
 * sanitizeName('LG C2 OLED') // => 'LG C2'
 * sanitizeName('Samsung G9 (2023)') // => 'Samsung G9'
 * sanitizeName('LG 27GR83Q-B') // => 'LG 27GR83Q-B' (preserves variant code)
 *
 * @param input - The product name to sanitize
 * @returns Sanitized product name with marketing terms removed
 */
export const sanitizeName = (input: string): string => {
  if (!input) return '';

  let sanitized = input;

  // Marketing terms categorized by type
  const PANEL_TYPES = [
    'QD-OLED',
    'QDOLED',
    'WOLED',
    'OLED',
    'IPS',
    'VA',
    'TN',
    'Mini-LED',
    'MiniLED',
    'Micro-LED',
    'MicroLED',
  ];

  const FEATURES = [
    'HDR',
    'HDR10',
    'HDR400',
    'HDR600',
    'HDR1000',
    'Dolby Vision',
    'FreeSync',
    'G-Sync',
    'NVIDIA G-Sync',
    'AMD FreeSync',
  ];

  const GENERATIONS = ['EVO', 'Gen 2', 'Gen2', 'V2', 'Edition'];

  const SIZE_PATTERNS = [
    '27-inch',
    '32-inch',
    '34-inch',
    '39-inch',
    '49-inch',
    '55-inch',
  ];

  const DESCRIPTORS = ['Gaming', 'Ultra', 'Pro', 'Plus'];

  const YEAR_PATTERNS = ['2020', '2021', '2022', '2023', '2024', '2025'];

  const PANEL_DESCRIPTORS = ['Panel'];

  // Terms that can appear anywhere (not just suffixes)
  const ANYWHERE_TERMS = [
    ...SIZE_PATTERNS,
    ...YEAR_PATTERNS,
    ...PANEL_DESCRIPTORS,
  ];

  // Terms that should only be removed from the end (suffixes)
  const SUFFIX_ONLY_TERMS = [
    ...PANEL_TYPES,
    ...FEATURES,
    ...GENERATIONS,
    ...DESCRIPTORS,
  ];

  // Escape special regex characters
  const escapeRegex = (str: string) =>
    str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Step 1: Remove bracket characters (but keep content inside)
  // Marketing term removal will handle unwanted content later
  sanitized = sanitized.replace(/[()[\]]/g, ' ');

  // Collapse spaces early to help with suffix matching
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  // Step 2: Remove descriptor terms anywhere in the string
  // Sort by length (longest first) to match multi-word terms before single words
  const anywhereTermsPattern = ANYWHERE_TERMS.sort(
    (a, b) => b.length - a.length,
  )
    .map(escapeRegex)
    .join('|');

  if (anywhereTermsPattern) {
    // Match whole words with word boundaries
    const anywhereRegex = new RegExp(`\\b(${anywhereTermsPattern})\\b`, 'gi');
    sanitized = sanitized.replace(anywhereRegex, ' ');
    // Collapse spaces after removal to help with suffix matching
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
  }

  // Step 3: Remove spaced marketing suffixes FIRST (e.g., " QD-OLED", " OLED", " Gaming")
  // This prevents internal hyphens in compound terms from being matched as hyphenated suffixes
  const allSuffixTerms = [...SUFFIX_ONLY_TERMS, ...ANYWHERE_TERMS];
  const allSuffixPattern = allSuffixTerms
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');

  if (allSuffixPattern) {
    // Match one or more marketing terms separated by spaces at the end
    const spacedSuffixPattern = new RegExp(
      `(\\s+(${allSuffixPattern}))+$`,
      'gi',
    );
    let previousSanitized = '';
    while (sanitized !== previousSanitized) {
      previousSanitized = sanitized;
      sanitized = sanitized.replace(spacedSuffixPattern, '');
    }
  }

  // Step 4: Remove hyphenated marketing suffixes
  // Handle complex terms with hyphens first (e.g., "-QD-OLED", "-Mini-LED")
  const complexTerms = SUFFIX_ONLY_TERMS.filter((term) => term.includes('-'));
  if (complexTerms.length > 0) {
    const complexPattern = complexTerms
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join('|');
    const complexHyphenatedPattern = new RegExp(
      `-\\s*(${complexPattern})$`,
      'gi',
    );
    sanitized = sanitized.replace(complexHyphenatedPattern, '');
  }

  // Then handle simple terms without hyphens (e.g., "-OLED", "-IPS")
  const simpleTerms = SUFFIX_ONLY_TERMS.filter((term) => !term.includes('-'));
  if (simpleTerms.length > 0) {
    const simpleSuffixPattern = simpleTerms
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join('|');

    // Match one or more simple marketing terms connected by hyphens at the end
    const hyphenatedSuffixPattern = new RegExp(
      `(-\\s*(${simpleSuffixPattern}))+$`,
      'gi',
    );
    let previousSanitized = '';
    while (sanitized !== previousSanitized) {
      previousSanitized = sanitized;
      sanitized = sanitized.replace(hyphenatedSuffixPattern, '');
    }
  }

  // Step 5: Clean up artifacts
  // Remove trailing and leading hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, '');

  // Remove trailing and leading underscores
  sanitized = sanitized.replace(/^_+|_+$/g, '');

  // Collapse consecutive hyphens
  sanitized = sanitized.replace(/--+/g, '-');

  // Collapse multiple spaces
  sanitized = sanitized.replace(/\s+/g, ' ');

  // Final trim
  sanitized = sanitized.trim();

  // If sanitization removed everything, return empty string
  return sanitized;
};

export const postProcessName = (input: string): string => {
  if (!input) return '';

  return input
    .replace(/[()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};
