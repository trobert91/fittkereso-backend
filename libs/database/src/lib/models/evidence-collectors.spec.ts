import { ProductReference } from '../postgres/models/product-reference.entity';
import { Sentiment } from '../postgres/types/sentiment';
import { Evidence, Quote } from './comment-context';
import {
  collectAllFeatures,
  collectAllIssues,
  collectAllUseCases,
} from './evidence-collectors';

function makeQuote(props: Partial<Quote> & Pick<Quote, 'id' | 'text' | 'sentiment'>): Quote {
  return props as Quote;
}

function makeRef(props: {
  features?: Evidence[] | null;
  useCases?: Evidence[] | null;
  quotes?: Quote[];
}): ProductReference {
  const ref = new ProductReference();
  ref.features = props.features ?? null;
  ref.useCases = props.useCases ?? null;
  ref.quotes = props.quotes ?? [];
  return ref;
}

describe('collectAllFeatures', () => {
  it('returns empty array when ref has no features and no quotes', () => {
    expect(collectAllFeatures(makeRef({}))).toEqual([]);
  });

  it('returns ref-level features as-is when no quotes', () => {
    const ref = makeRef({
      features: [{ label: 'dual use', sentiment: Sentiment.Positive }],
    });
    expect(collectAllFeatures(ref)).toEqual([
      { label: 'dual use', sentiment: Sentiment.Positive },
    ]);
  });

  it('includes quote features with sentiment resolved via effectiveSentiment', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'love the colors',
          sentiment: Sentiment.Positive,
          features: [{ label: 'colors' }], // inherits Positive from quote
        }),
      ],
    });
    expect(collectAllFeatures(ref)).toEqual([
      { label: 'colors', sentiment: Sentiment.Positive },
    ]);
  });

  it('skips speculative quotes entirely', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'I heard the colors are great',
          sentiment: Sentiment.Positive,
          speculative: true,
          features: [{ label: 'colors' }],
        }),
      ],
    });
    expect(collectAllFeatures(ref)).toEqual([]);
  });

  it('dedups same label + sentiment across ref and quote levels', () => {
    const ref = makeRef({
      features: [{ label: 'colors', sentiment: Sentiment.Positive }],
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'colors pop',
          sentiment: Sentiment.Positive,
          features: [{ label: 'colors' }],
        }),
      ],
    });
    expect(collectAllFeatures(ref)).toEqual([
      { label: 'colors', sentiment: Sentiment.Positive },
    ]);
  });

  it('keeps both entries when same label has different sentiments', () => {
    const ref = makeRef({
      features: [{ label: 'colors', sentiment: Sentiment.Positive }],
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'stand is bad',
          sentiment: Sentiment.Negative,
          features: [{ label: 'colors', sentiment: Sentiment.Negative }],
        }),
      ],
    });
    const result = collectAllFeatures(ref);
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { label: 'colors', sentiment: Sentiment.Positive },
        { label: 'colors', sentiment: Sentiment.Negative },
      ]),
    );
  });

});

describe('collectAllUseCases', () => {
  it('returns ref-level use cases when no quotes', () => {
    const ref = makeRef({
      useCases: [{ label: 'dual use', sentiment: Sentiment.Positive }],
    });
    expect(collectAllUseCases(ref)).toEqual([
      { label: 'dual use', sentiment: Sentiment.Positive },
    ]);
  });

  it('combines ref-level and quote-level use cases', () => {
    const ref = makeRef({
      useCases: [{ label: 'dual use', sentiment: Sentiment.Positive }],
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'great for Excel',
          sentiment: Sentiment.Positive,
          useCases: [{ label: 'office' }],
        }),
        makeQuote({
          id: 'q2',
          text: 'great for Forza',
          sentiment: Sentiment.Positive,
          useCases: [{ label: 'sim racing' }],
        }),
      ],
    });
    const result = collectAllUseCases(ref);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.label).sort()).toEqual(['dual use', 'office', 'sim racing']);
  });

  it('skips speculative quotes', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: "I'd use it for gaming probably",
          sentiment: Sentiment.Positive,
          speculative: true,
          useCases: [{ label: 'PC gaming' }],
        }),
      ],
    });
    expect(collectAllUseCases(ref)).toEqual([]);
  });

  it('dedups by (label, sentiment) — same label twice with same sentiment collapses', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'great for gaming',
          sentiment: Sentiment.Positive,
          useCases: [{ label: 'PC gaming' }],
        }),
        makeQuote({
          id: 'q2',
          text: 'great for gaming again',
          sentiment: Sentiment.Positive,
          useCases: [{ label: 'PC gaming' }],
        }),
      ],
    });
    expect(collectAllUseCases(ref)).toEqual([
      { label: 'PC gaming', sentiment: Sentiment.Positive },
    ]);
  });
});

describe('collectAllIssues', () => {
  it('returns empty array when no quotes carry issues', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'love it',
          sentiment: Sentiment.Positive,
          features: [{ label: 'colors' }],
        }),
      ],
    });
    expect(collectAllIssues(ref)).toEqual([]);
  });

  it('collects quote-level issues with their sentiment', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'VRR black screen issue',
          sentiment: Sentiment.Negative,
          issues: [
            { label: 'vrr black screen', sentiment: Sentiment.Negative },
          ],
        }),
        makeQuote({
          id: 'q2',
          text: 'DOA panel uniformity disaster',
          sentiment: Sentiment.StrongNegative,
          issues: [
            { label: 'panel uniformity', sentiment: Sentiment.StrongNegative },
          ],
        }),
      ],
    });
    expect(collectAllIssues(ref)).toEqual([
      { label: 'vrr black screen', sentiment: Sentiment.Negative },
      { label: 'panel uniformity', sentiment: Sentiment.StrongNegative },
    ]);
  });

  it('skips speculative quotes', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'I heard it has VRR issues',
          sentiment: Sentiment.Negative,
          speculative: true,
          issues: [{ label: 'vrr black screen', sentiment: Sentiment.Negative }],
        }),
      ],
    });
    expect(collectAllIssues(ref)).toEqual([]);
  });

  it('dedups by (label, sentiment) — same issue twice with same severity collapses', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'fan noise',
          sentiment: Sentiment.Negative,
          issues: [{ label: 'fan noise loud', sentiment: Sentiment.Negative }],
        }),
        makeQuote({
          id: 'q2',
          text: 'fan noise again',
          sentiment: Sentiment.Negative,
          issues: [{ label: 'fan noise loud', sentiment: Sentiment.Negative }],
        }),
      ],
    });
    expect(collectAllIssues(ref)).toEqual([
      { label: 'fan noise loud', sentiment: Sentiment.Negative },
    ]);
  });

  it('keeps both entries when same issue label has different severities', () => {
    const ref = makeRef({
      quotes: [
        makeQuote({
          id: 'q1',
          text: 'minor fan noise',
          sentiment: Sentiment.Negative,
          issues: [{ label: 'fan noise loud', sentiment: Sentiment.Negative }],
        }),
        makeQuote({
          id: 'q2',
          text: 'deafening fan noise',
          sentiment: Sentiment.StrongNegative,
          issues: [{ label: 'fan noise loud', sentiment: Sentiment.StrongNegative }],
        }),
      ],
    });
    const result = collectAllIssues(ref);
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { label: 'fan noise loud', sentiment: Sentiment.Negative },
        { label: 'fan noise loud', sentiment: Sentiment.StrongNegative },
      ]),
    );
  });
});
