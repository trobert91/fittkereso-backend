export type SpecMatchResult = 'match' | 'compatible' | 'mismatch';

export interface SpecMatchDetail {
  key: string;
  isPrimary: boolean;
  isMatcher?: boolean;
  valueA: string | number | boolean | string[] | undefined;
  valueB: string | number | boolean | string[] | undefined;
  match: SpecMatchResult;
}

export interface SpecMatchDetails {
  /** Number of specs present in both products */
  comparableCount: number;
  matchingCount: number;
  primaryMismatches: number;
  matcherSpecMismatches: number;
  nonPrimaryMismatches: number;
  details: SpecMatchDetail[];
}
