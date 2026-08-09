export interface RelevanceTerm {
  keyword: string;
  weight: number;
  /** If true, this term is a strong disambiguator unique to this category (e.g. "G-Sync" for Monitors). Exclusive matches apply a score boost. */
  exclusive?: boolean;
}

/** A term whose presence indicates this is likely NOT the right category. */
export interface NegativeTerm {
  keyword: string;
  /** Multiplicative penalty per match (0.0–1.0). E.g. 0.7 reduces score by 30% per match. */
  penalty: number;
}
