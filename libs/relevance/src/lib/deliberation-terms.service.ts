import { Injectable } from '@nestjs/common';
import { search as fuzzySearch } from 'fast-fuzzy';
import { ScoringConfigService } from './scoring-config.service';
import { sumBy } from 'lodash';

export interface DeliberationSignal {
  keyword: string;
  score: number;
}

@Injectable()
export class DeliberationTermsService {
  constructor(private readonly scoringConfig: ScoringConfigService) {}
  /**
   * Buyer deliberation phrases.
   * These indicate comparison, concern, expectation, or trade-off thinking.
   */
  private readonly DELIBERATION_PHRASES: string[] = [
    'i am concerned',
    'i am concern',
    'might make more sense',
    'could be better',
    'could be worse',
    'i am worried',
    'i wonder if',
    'i am considering',
    'i am debating',
    'trying to decide',
    'not sure if',
    'does it make sense',
    'worth the tradeoff',
    'compared to',
    'versus',
    'vs',
    'but',
    'however',
    'on the other hand',
    'especially when',
    'in my use case',
    'for my use',
    'expect it to',
    'i expect',
  ];

  /**
   * Extract deliberation signals from text.
   */
  extractSignals(contents: string[]): DeliberationSignal[] {
    const signals: DeliberationSignal[] = [];

    for (const phrase of this.DELIBERATION_PHRASES) {
      const deliberation = this.scoringConfig.deliberation;
      const matches = fuzzySearch(phrase, contents, {
        ignoreCase: true,
        threshold: deliberation.fuzzyThreshold,
        returnMatchData: true,
      });

      if (!matches.length) continue;

      const similaritySum = sumBy(matches, 'score');
      const phraseBoost = phrase.includes(' ') ? deliberation.phraseBoostMultiplier : 1.0;

      signals.push({
        keyword: phrase,
        score: similaritySum * phraseBoost,
      });
    }

    return signals;
  }

  /**
   * Convert deliberation signals into a multiplier.
   *
   * - No signals → 1.0
   * - Strong deliberation → up to 1.25x
   */
  computeMultiplier(contents: string[]): {
    multiplier: number;
    signals: DeliberationSignal[];
  } {
    const signals = this.extractSignals(contents);
    if (!signals.length) {
      return { multiplier: 1.0, signals: [] };
    }

    const rawScore = sumBy(signals, 'score');

    /**
     * Soft saturation curve:
     *  - small signals matter
     *  - large essays don't explode the score
     */
    const deliberation = this.scoringConfig.deliberation;
    const normalized = Math.min(1, rawScore / deliberation.saturationDivisor);

    const multiplier = 1.0 + normalized * deliberation.maxMultiplierBoost;

    return {
      multiplier,
      signals,
    };
  }
}
