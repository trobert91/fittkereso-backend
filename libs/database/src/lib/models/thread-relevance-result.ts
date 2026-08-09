export type RelevanceRating = 'low' | 'medium' | 'high';

export interface RelevanceCriteriaRatings {
  experienceDensity: RelevanceRating;
  productSpecificity: RelevanceRating;
  featureDiscussion: RelevanceRating;
  buyerResearchValue: RelevanceRating;
  comparativeContent: RelevanceRating;
}

export interface RelevanceScoreBreakdown {
  llmScore: number;
  /** @deprecated Kept for backward compatibility with historical rows; no longer written. */
  estimationScore?: number;
  commentCountFactor: number;
  recencyFactor: number;
}

export interface RelevanceResult {
  criteria: RelevanceCriteriaRatings;
  weightedScore: number; // normalized 1-100, composite
  breakdown?: RelevanceScoreBreakdown;
}
