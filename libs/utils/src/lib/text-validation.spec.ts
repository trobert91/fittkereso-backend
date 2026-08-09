import { textExistsInSource, stripMarkdownLinks, stripPunctuation, containsNearDuplicateSubstring } from './text-validation';

describe('stripMarkdownLinks', () => {
  it('should replace markdown link with just the text', () => {
    expect(stripMarkdownLinks('[341CQPX](https://msi.com)')).toBe('341CQPX');
  });

  it('should handle multiple links', () => {
    expect(stripMarkdownLinks('[LG](https://lg.com) and [MSI](https://msi.com)')).toBe('LG and MSI');
  });

  it('should preserve non-link text', () => {
    expect(stripMarkdownLinks('plain text without links')).toBe('plain text without links');
  });

  it('should handle link text with spaces', () => {
    expect(stripMarkdownLinks('[X34 X5](https://bestbuy.com/site/acer)')).toBe('X34 X5');
  });

  it('should strip orphaned brackets from partial markdown copies', () => {
    expect(stripMarkdownLinks('LG Ultragear [34GS95QE-B]')).toBe('LG Ultragear 34GS95QE-B');
    expect(stripMarkdownLinks('MSI MPG [341CQPX]')).toBe('MSI MPG 341CQPX');
    expect(stripMarkdownLinks('ROG swift [PG34WCDM]')).toBe('ROG swift PG34WCDM');
  });

  it('should preserve array-index brackets like arr[0]', () => {
    expect(stripMarkdownLinks('array[0] and scores[i]')).toBe('array[0] and scores[i]');
  });

  it('should preserve parentheses', () => {
    expect(stripMarkdownLinks('text with (parentheses)')).toBe('text with (parentheses)');
  });
});

describe('stripPunctuation', () => {
  it('should remove commas and periods', () => {
    expect(stripPunctuation('hello, world.')).toBe('hello world');
  });

  it('should remove quotes and apostrophes', () => {
    expect(stripPunctuation('"it\'s great"')).toBe('it s great');
  });

  it('should collapse multiple spaces from consecutive punctuation', () => {
    expect(stripPunctuation('wow... amazing!!!')).toBe('wow amazing');
  });

  it('should preserve letters and digits', () => {
    expect(stripPunctuation('model X34 costs $500')).toBe('model X34 costs 500');
  });

  it('should handle empty string', () => {
    expect(stripPunctuation('')).toBe('');
  });

  it('should handle unicode letters', () => {
    expect(stripPunctuation('café résumé!')).toBe('café résumé');
  });
});

describe('textExistsInSource', () => {
  describe('exact substring match', () => {
    it('should find exact match', () => {
      expect(textExistsInSource('great monitor', 'This is a great monitor for gaming')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(textExistsInSource('Great Monitor', 'this is a great monitor')).toBe(true);
    });

    it('should match full source text', () => {
      expect(textExistsInSource('hello world', 'hello world')).toBe(true);
    });

    it('should not match text that does not appear', () => {
      expect(textExistsInSource('terrible product', 'This is a great monitor')).toBe(false);
    });
  });

  describe('short-text fallback', () => {
    it('should match when all significant words appear individually (2 words)', () => {
      expect(textExistsInSource('great gaming', 'This is a great monitor for gaming use')).toBe(true);
    });

    it('should match when all significant words appear individually (3 words)', () => {
      expect(textExistsInSource('great gaming monitor', 'This great product is a gaming monitor')).toBe(true);
    });

    it('should not use fallback for 4+ words', () => {
      expect(textExistsInSource('great gaming monitor review', 'This great product is a gaming monitor for review')).toBe(false);
    });

    it('should skip words with length <= 2 in fallback check', () => {
      // "is" has length 2, so it's skipped; "great" must appear
      expect(textExistsInSource('is great', 'This product is excellent')).toBe(false);
      expect(textExistsInSource('is great', 'This great product')).toBe(true);
    });

    it('should not match when a significant word is missing', () => {
      expect(textExistsInSource('great terrible', 'This is a great monitor')).toBe(false);
    });
  });

  describe('markdown link stripping', () => {
    it('should match product name split by markdown link in source', () => {
      const source = 'MSI MPG [341CQPX](https://www.msi.com/Monitor/MPG-341CQPX-QD-OLED/Specification)';
      expect(textExistsInSource('MSI MPG 341CQPX', source)).toBe(true);
    });

    it('should match product name with markdown link containing brand only', () => {
      const source = 'Acer Predator [X34 X5](https://www.bestbuy.com/site/acer-predator)';
      expect(textExistsInSource('Acer Predator X34 X5', source)).toBe(true);
    });

    it('should match when source has multiple markdown links', () => {
      const source = 'LG [34GS95QE-B](https://lg.com) vs MSI [341CQPX](https://msi.com)';
      expect(textExistsInSource('LG 34GS95QE-B', source)).toBe(true);
      expect(textExistsInSource('MSI 341CQPX', source)).toBe(true);
    });

    it('should still reject genuinely hallucinated text with markdown in source', () => {
      const source = 'MSI MPG [341CQPX](https://msi.com)';
      expect(textExistsInSource('Samsung Odyssey G9', source)).toBe(false);
    });

    it('should match when LLM keeps brackets but drops URL from markdown link', () => {
      const source = 'LG Ultragear [34GS95QE-B](https://www.lg.com/us/monitors/lg-34gs95qe-b-gaming-monitor)';
      expect(textExistsInSource('LG Ultragear [34GS95QE-B]', source)).toBe(true);
    });

    it('should match orphaned brackets for all product types', () => {
      const source = `LG Ultragear [34GS95QE-B](https://www.lg.com)
MSI MPG [341CQPX](https://www.msi.com)
Acer Predator [X34 X5](https://www.bestbuy.com)
Gigabyte [MO34WQC2](https://www.gigabyte.com)
ROG swift [PG34WCDM](https://rog.asus.com)`;
      expect(textExistsInSource('LG Ultragear [34GS95QE-B]', source)).toBe(true);
      expect(textExistsInSource('MSI MPG [341CQPX]', source)).toBe(true);
      expect(textExistsInSource('Acer Predator [X34 X5]', source)).toBe(true);
      expect(textExistsInSource('Gigabyte [MO34WQC2]', source)).toBe(true);
      expect(textExistsInSource('ROG swift [PG34WCDM]', source)).toBe(true);
    });

    it('should match when LLM includes markdown link in textSpan (both sides have links)', () => {
      const source = 'LG Ultragear [34GS95QE-B](https://www.lg.com/us/monitors/lg-34gs95qe-b-gaming-monitor)';
      const span = 'LG Ultragear [34GS95QE-B](https://www.lg.com/us/monitors/lg-34gs95qe-b-gaming-monitor)';
      expect(textExistsInSource(span, source)).toBe(true);
    });

    it('should match when LLM copies markdown link verbatim from comment', () => {
      const source = 'MSI MPG [341CQPX](https://www.msi.com/Monitor/MPG-341CQPX-QD-OLED/Specification)';
      const span = 'MSI MPG [341CQPX](https://www.msi.com/Monitor/MPG-341CQPX-QD-OLED/Specification)';
      expect(textExistsInSource(span, source)).toBe(true);
    });

    it('should match when LLM copies link with spaces in text part', () => {
      const source = 'Acer Predator [X34 X5](https://www.bestbuy.com/site/acer-predator)';
      const span = 'Acer Predator [X34 X5](https://www.bestbuy.com/site/acer-predator)';
      expect(textExistsInSource(span, source)).toBe(true);
    });

    it('should match when LLM copies link with fragment in URL', () => {
      const source = 'Gigabyte [MO34WQC2](https://www.gigabyte.com/Monitor/MO34WQC2/gallery#gallery)';
      const span = 'Gigabyte [MO34WQC2](https://www.gigabyte.com/Monitor/MO34WQC2/gallery#gallery)';
      expect(textExistsInSource(span, source)).toBe(true);
    });
  });

  describe('punctuation-normalized fallback (4+ words)', () => {
    it('should match when source has extra comma', () => {
      const source = 'Yes, the curve is perfect and I love gaming on it';
      expect(textExistsInSource('Yes the curve is perfect', source)).toBe(true);
    });

    it('should match when text has extra comma not in source', () => {
      const source = 'Yes the curve is perfect and I love gaming on it';
      expect(textExistsInSource('Yes, the curve is perfect', source)).toBe(true);
    });

    it('should match when period is missing from text', () => {
      const source = 'The OLED colors are amazing. Battery life is fine.';
      expect(textExistsInSource('The OLED colors are amazing', source)).toBe(true);
    });

    it('should match when text has period but source has exclamation', () => {
      const source = 'The colors are so vivid! I was impressed';
      expect(textExistsInSource('The colors are so vivid.', source)).toBe(true);
    });

    it('should NOT match when words are in different order (hallucination)', () => {
      const source = 'The curve is perfect and colors are vivid';
      expect(textExistsInSource('The perfect curve is vivid', source)).toBe(false);
    });

    it('should NOT match genuinely hallucinated 4+ word text', () => {
      const source = 'I love this monitor for gaming';
      expect(textExistsInSource('The display quality is excellent', source)).toBe(false);
    });

    it('should NOT apply fuzzy to 3-word texts with punctuation diff', () => {
      // "great, monitor overall" — 3 words, exact fails, short-text fallback:
      // "great," not found as substring (comma attached), so it fails.
      // Strategy 3 doesn't trigger (< 4 words). Should be false.
      const source = 'This is a great monitor overall for gaming';
      expect(textExistsInSource('great, monitor overall', source)).toBe(false);
    });

    it('should match when source has semicolon instead of comma', () => {
      const source = 'Great colors; smooth refresh rate; good price overall';
      expect(textExistsInSource('Great colors, smooth refresh rate', source)).toBe(true);
    });

    it('should match when both have different quote styles', () => {
      const source = 'He said "the monitor is great" and I agree';
      expect(textExistsInSource("He said 'the monitor is great' and I agree", source)).toBe(true);
    });

    it('should NOT match when extra words are inserted (not a substring)', () => {
      const source = 'The OLED colors are amazing';
      expect(textExistsInSource('The OLED panel colors are amazing', source)).toBe(false);
    });

    it('should handle text with ellipsis vs normal spacing', () => {
      const source = 'The build quality is good... but the price is high';
      expect(textExistsInSource('The build quality is good but the price is high', source)).toBe(true);
    });
  });

  describe('empty and whitespace inputs', () => {
    it('should return false for empty text', () => {
      expect(textExistsInSource('', 'some source')).toBe(false);
    });

    it('should return false for whitespace-only text', () => {
      expect(textExistsInSource('   ', 'some source')).toBe(false);
    });

    it('should return false for text not in empty source', () => {
      expect(textExistsInSource('hello', '')).toBe(false);
    });
  });
});

describe('containsNearDuplicateSubstring', () => {
  it('detects exact substring containment', () => {
    expect(
      containsNearDuplicateSubstring(
        'it definitely feels smoother and the colors are crazy',
        'the colors are crazy',
      ),
    ).toBe(true);
  });

  it('detects near-substring with single-word edits', () => {
    expect(
      containsNearDuplicateSubstring(
        'it definitely feels smoother and the colours are crazyy',
        'the colors are crazy',
      ),
    ).toBe(true);
  });

  it('returns false when shorter is not actually shorter', () => {
    expect(
      containsNearDuplicateSubstring('the colors are crazy', 'the colors are crazy'),
    ).toBe(false);
  });

  it('returns false for unrelated texts', () => {
    expect(
      containsNearDuplicateSubstring(
        'it definitely feels smoother and the colors are crazy',
        'the response time is awful',
      ),
    ).toBe(false);
  });

  it('returns false when either input is empty', () => {
    expect(containsNearDuplicateSubstring('', 'something')).toBe(false);
    expect(containsNearDuplicateSubstring('something', '')).toBe(false);
  });

  it('normalizes punctuation differences', () => {
    expect(
      containsNearDuplicateSubstring(
        'It definitely feels smoother, and the colors are crazy!',
        'the colors are crazy',
      ),
    ).toBe(true);
  });
});
