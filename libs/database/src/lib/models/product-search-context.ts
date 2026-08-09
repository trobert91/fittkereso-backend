import type { SpecMatchDetails } from '../postgres/types/spec-match-details';

export interface MatchResultComponents {
  stringSimilarity: number;
  tokenOverlap: number;
  alphaMatch: number;
  aliasMatch: boolean;
  specSimilarity: number;
}

export const EMPTY_MATCH_RESULT_COMPONENTS: MatchResultComponents = {
  stringSimilarity: 0,
  tokenOverlap: 0,
  alphaMatch: 0,
  aliasMatch: false,
  specSimilarity: 0,
};

export interface MatchResult {
  candidateId: string;
  alias: string;
  score: number;
  components: MatchResultComponents;
  specMatchDetails?: SpecMatchDetails;
}
