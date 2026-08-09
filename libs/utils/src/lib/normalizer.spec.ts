import { normalize, sanitizeName, sanitizeText } from './normalizer';

describe('normalize', () => {
  it('should convert to lowercase and collapse spaces', () => {
    expect(normalize('LG  C2   OLED')).toBe('lg c2 oled');
  });

  it('should handle empty input', () => {
    expect(normalize('')).toBe('');
    expect(normalize(null as any)).toBe('');
    expect(normalize(undefined as any)).toBe('');
  });

  it('should trim leading and trailing spaces', () => {
    expect(normalize('  LG C2  ')).toBe('lg c2');
  });
});

describe('sanitizeName', () => {
  describe('empty input handling', () => {
    it('should handle empty input', () => {
      expect(sanitizeName('')).toBe('');
      expect(sanitizeName(null as any)).toBe('');
      expect(sanitizeName(undefined as any)).toBe('');
    });
  });

  describe('bracket removal', () => {
    it('should remove content in parentheses', () => {
      expect(sanitizeName('Samsung G9 (2023)')).toBe('Samsung G9');
      expect(sanitizeName('Model (QD-OLED)')).toBe('Model');
      expect(sanitizeName('LG (OLED Panel)')).toBe('LG');
    });

    it('should remove content in square brackets', () => {
      expect(sanitizeName('Model [27-inch]')).toBe('Model');
      expect(sanitizeName('Model [Gaming Edition]')).toBe('Model');
    });

    it('should remove multiple bracketed sections', () => {
      expect(sanitizeName('Model (2023) [Gaming]')).toBe('Model');
    });
  });

  describe('hyphenated suffix removal', () => {
    it('should remove hyphenated panel type suffixes', () => {
      expect(sanitizeName('MSI MPG-341CQPX-QD-OLED')).toBe('MSI MPG-341CQPX');
      expect(sanitizeName('Model-OLED')).toBe('Model');
      expect(sanitizeName('Model-IPS')).toBe('Model');
      expect(sanitizeName('Model-VA')).toBe('Model');
    });

    it('should remove multiple hyphenated simple suffixes', () => {
      expect(sanitizeName('Model-OLED-HDR')).toBe('Model');
      expect(sanitizeName('Monitor-IPS-HDR')).toBe('Monitor');
    });

    it('should handle QDOLED variant without hyphen', () => {
      expect(sanitizeName('MSI MPG-341CQPX-QDOLED')).toBe('MSI MPG-341CQPX');
    });

    it('should preserve  model number hyphens', () => {
      expect(sanitizeName('LG 27GR83Q-B')).toBe('LG 27GR83Q-B');
      expect(sanitizeName('LG 34GS95QE-B')).toBe('LG 34GS95QE-B');
      expect(sanitizeName('ASUS PG27AQDM-B')).toBe('ASUS PG27AQDM-B');
    });
  });

  describe('spaced suffix removal', () => {
    it('should remove spaced panel type suffixes', () => {
      expect(sanitizeName('LG C2 OLED')).toBe('LG C2');
      expect(sanitizeName('Model QD-OLED')).toBe('Model');
      expect(sanitizeName('MSI MPG-341CQPX-QD-OLED')).toBe('MSI MPG-341CQPX');
      expect(sanitizeName('Monitor IPS')).toBe('Monitor');
    });

    it('should remove multiple spaced suffixes', () => {
      expect(sanitizeName('Model OLED HDR')).toBe('Model');
      expect(sanitizeName('Monitor IPS HDR')).toBe('Monitor');
    });
  });

  describe('marketing term removal', () => {
    it('should remove panel types', () => {
      expect(sanitizeName('Model QD-OLED')).toBe('Model');
      expect(sanitizeName('Model WOLED')).toBe('Model');
      expect(sanitizeName('Model OLED')).toBe('Model');
      expect(sanitizeName('Model IPS')).toBe('Model');
      expect(sanitizeName('Model VA')).toBe('Model');
      expect(sanitizeName('Model TN')).toBe('Model');
      expect(sanitizeName('Model Mini-LED')).toBe('Model');
    });

    it('should remove feature terms', () => {
      expect(sanitizeName('Model HDR')).toBe('Model');
      expect(sanitizeName('Model FreeSync')).toBe('Model');
      expect(sanitizeName('Model G-Sync')).toBe('Model');
    });

    it('should remove descriptor terms', () => {
      expect(sanitizeName('Model Gaming')).toBe('Model');
      expect(sanitizeName('Model Ultra')).toBe('Model');
      expect(sanitizeName('Model Pro')).toBe('Model');
      expect(sanitizeName('Model Plus')).toBe('Model');
    });

    it('should remove generation markers', () => {
      expect(sanitizeName('Model EVO')).toBe('Model');
      expect(sanitizeName('Model Gen 2')).toBe('Model');
      expect(sanitizeName('Model Gen2')).toBe('Model');
    });
  });

  describe('case insensitivity', () => {
    it('should handle mixed case marketing terms', () => {
      expect(sanitizeName('Model-qd-oled')).toBe('Model');
      expect(sanitizeName('Model-Qd-Oled')).toBe('Model');
      expect(sanitizeName('Model oled')).toBe('Model');
      expect(sanitizeName('Model OLED')).toBe('Model');
    });
  });

  describe('artifact cleanup', () => {
    it('should remove trailing hyphens', () => {
      expect(sanitizeName('Model-')).toBe('Model');
      expect(sanitizeName('Model--')).toBe('Model');
    });

    it('should remove leading hyphens', () => {
      expect(sanitizeName('-Model')).toBe('Model');
      expect(sanitizeName('--Model')).toBe('Model');
    });

    it('should collapse consecutive hyphens', () => {
      expect(sanitizeName('Model--Name')).toBe('Model-Name');
      expect(sanitizeName('Model---Name')).toBe('Model-Name');
    });

    it('should collapse multiple spaces', () => {
      expect(sanitizeName('Model   Name')).toBe('Model Name');
    });
  });

  describe('real-world examples', () => {
    it('should handle MSI monitor model', () => {
      expect(sanitizeName('MSI MPG-341CQPX-QD-OLED')).toBe('MSI MPG-341CQPX');
    });

    it('should handle LG OLED TV models', () => {
      expect(sanitizeName('LG C2 OLED')).toBe('LG C2');
      expect(sanitizeName('LG C3 OLED')).toBe('LG C3');
    });

    it('should handle LG monitor models', () => {
      expect(sanitizeName('LG 27GR83Q-B')).toBe('LG 27GR83Q-B');
      expect(sanitizeName('LG 34GS95QE-B OLED')).toBe('LG 34GS95QE-B');
      expect(sanitizeName('LG Ultragear [34GS95QE-B]')).toBe(
        'LG Ultragear 34GS95QE-B',
      );
    });

    it('should handle ASUS models', () => {
      expect(sanitizeName('ASUS VG27AQL1A')).toBe('ASUS VG27AQL1A');
    });

    it('should handle Samsung models', () => {
      expect(sanitizeName('Samsung G9 (2023)')).toBe('Samsung G9');
    });

    it('should handle models with brackets and marketing terms', () => {
      expect(sanitizeName('Model (QD-OLED) Edition')).toBe('Model');
      expect(sanitizeName('Monitor [27-inch] IPS')).toBe('Monitor');
    });
  });

  describe('edge cases', () => {
    it('should handle marketing terms in the middle (suffix-only mode)', () => {
      // Panel types are only removed as suffixes, not from the middle
      expect(sanitizeName('LG OLED C2')).toBe('LG OLED C2');
    });

    it('should handle variant codes that look like marketing terms', () => {
      // Preserve short variant codes like -B, -W even if they might match patterns
      expect(sanitizeName('Model-B')).toBe('Model-B');
      expect(sanitizeName('Model-W')).toBe('Model-W');
      expect(sanitizeName('Model-BK')).toBe('Model-BK');
    });
  });
});

describe('sanitizeText', () => {
  // Build test inputs from codepoints so the spec source stays free of
  // invisible / look-alike Unicode characters.
  const cp = (...codepoints: number[]): string =>
    String.fromCodePoint(...codepoints);

  describe('empty input handling', () => {
    it('preserves empty / nullish inputs', () => {
      expect(sanitizeText('')).toBe('');
      expect(sanitizeText(null)).toBe('');
      expect(sanitizeText(undefined)).toBe('');
    });
  });

  describe('typographic quotes', () => {
    it("folds curly single quotes to ASCII '", () => {
      // U+2018 left, U+2019 right, U+201A low-9, U+201B reversed-9, U+2032 prime
      const input = `they${cp(0x2019)}re ${cp(0x2018)}nice${cp(0x2019)} ${cp(0x201a)}low${cp(0x201b)} ${cp(0x2032)}prime`;
      expect(sanitizeText(input)).toBe("they're 'nice' 'low' 'prime");
    });

    it('folds curly double quotes to ASCII "', () => {
      // U+201C left, U+201D right, U+201E low-9, U+201F reversed-9, U+2033 double-prime, U+00AB/U+00BB guillemets
      const input = `${cp(0x201c)}quoted${cp(0x201d)} ${cp(0x201e)}low${cp(0x201f)} ${cp(0x2033)}double-prime ${cp(0x00ab)}fr${cp(0x00bb)}`;
      expect(sanitizeText(input)).toBe('"quoted" "low" "double-prime "fr"');
    });
  });

  describe('dashes and ellipsis', () => {
    it('folds em dash and horizontal bar to --', () => {
      // U+2014 em dash, U+2015 horizontal bar
      expect(sanitizeText(`a${cp(0x2014)}b`)).toBe('a--b');
      expect(sanitizeText(`a${cp(0x2015)}b`)).toBe('a--b');
    });

    it('folds en dash, hyphen, non-breaking hyphen, and minus sign to -', () => {
      // U+2010 hyphen, U+2011 NB hyphen, U+2013 en dash, U+2212 minus sign
      expect(sanitizeText(`a${cp(0x2010)}b`)).toBe('a-b');
      expect(sanitizeText(`a${cp(0x2011)}b`)).toBe('a-b');
      expect(sanitizeText(`a${cp(0x2013)}b`)).toBe('a-b');
      expect(sanitizeText(`a${cp(0x2212)}b`)).toBe('a-b');
    });

    it('folds the ellipsis character to ...', () => {
      expect(sanitizeText(`wait${cp(0x2026)}`)).toBe('wait...');
    });
  });

  describe('whitespace', () => {
    it('folds NBSP and other non-ASCII spaces to a regular space', () => {
      // U+00A0 NBSP, U+202F narrow-NBSP, U+3000 ideographic space, U+2003 em space
      expect(sanitizeText(`a${cp(0x00a0)}b`)).toBe('a b');
      expect(sanitizeText(`a${cp(0x202f)}b`)).toBe('a b');
      expect(sanitizeText(`a${cp(0x3000)}b`)).toBe('a b');
      expect(sanitizeText(`a${cp(0x2003)}b`)).toBe('a b');
    });

    it('folds line / paragraph separator to newline', () => {
      // U+2028 line separator, U+2029 paragraph separator
      expect(sanitizeText(`a${cp(0x2028)}b`)).toBe('a\nb');
      expect(sanitizeText(`a${cp(0x2029)}b`)).toBe('a\nb');
    });

    it('preserves regular newlines and existing ASCII spaces', () => {
      expect(sanitizeText('line1\nline2\n\nline3')).toBe('line1\nline2\n\nline3');
    });
  });

  describe('zero-width / formatting characters', () => {
    it('strips ZWSP/ZWNJ/ZWJ/BOM/soft-hyphen/LRM/RLM', () => {
      const codepoints = [0x200b, 0x200c, 0x200d, 0xfeff, 0x00ad, 0x200e, 0x200f];
      for (const c of codepoints) {
        expect(sanitizeText(`a${cp(c)}b`)).toBe('ab');
      }
    });
  });

  describe('NFC normalization', () => {
    it('combines decomposed accents into precomposed form', () => {
      // 'e' + combining acute (U+0301) → 'é' (U+00E9)
      const decomposed = `caf${cp(0x65, 0x0301)}`;
      const precomposed = `caf${cp(0x00e9)}`;
      expect(sanitizeText(decomposed)).toBe(precomposed);
    });
  });

  describe('markdown backslash escapes', () => {
    it('strips backslashes preceding markdown punctuation', () => {
      expect(sanitizeText(String.raw`s\*\*t`)).toBe('s**t');
      expect(sanitizeText(String.raw`\_word\_`)).toBe('_word_');
      expect(sanitizeText(String.raw`\[link\]\(url\)`)).toBe('[link](url)');
      expect(sanitizeText(String.raw`\>quote`)).toBe('>quote');
      expect(sanitizeText(String.raw`\#hash \! \. \-`)).toBe('#hash ! . -');
    });

    it('does NOT strip backslashes in front of letters or digits', () => {
      expect(sanitizeText(String.raw`path\to\file`)).toBe('path\\to\\file');
      expect(sanitizeText(String.raw`a\b\c`)).toBe('a\\b\\c');
    });
  });

  describe('preservation', () => {
    it('preserves casing', () => {
      expect(sanitizeText('LG UltraGear 34GS95QE-B')).toBe('LG UltraGear 34GS95QE-B');
    });

    it('passes pure ASCII through unchanged', () => {
      const input = 'I tried 3 DP and 2 HDMI cables and everytime chose 144Hz.';
      expect(sanitizeText(input)).toBe(input);
    });
  });

  describe('idempotency', () => {
    it('produces stable output when applied twice', () => {
      const inputs = [
        `they${cp(0x2019)}re ${cp(0x201c)}nice${cp(0x201d)}, but${cp(0x2014)}wait${cp(0x2026)}`,
        String.raw`s\*\*t and \_emphasis\_`,
        `caf${cp(0x65, 0x0301)} ${cp(0x00a0)}au lait`,
        `mixed${cp(0x200b)} zero-width${cp(0x200d)} chars`,
      ];
      for (const input of inputs) {
        const once = sanitizeText(input);
        expect(sanitizeText(once)).toBe(once);
      }
    });
  });

  describe('combined real-world example (m7r0e1z bug)', () => {
    it('canonicalizes the apostrophe drift that broke quote_not_verbatim', () => {
      const body = `So I just checked, seems HDR stays on with the Freesync turned on! 175Hz still. All is good! And yes I believe they${cp(0x2019)}re the same panel.`;
      const sanitized = sanitizeText(body);
      // ASCII apostrophe should now appear and the LLM-emitted "they're"
      // would become a verbatim substring of the body.
      expect(sanitized).toContain("they're");
      expect(sanitized).not.toContain(cp(0x2019));
    });
  });
});
