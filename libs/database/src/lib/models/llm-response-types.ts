import { Depth, ExperienceType, Intent, Sentiment } from '../postgres';

/** Raw shape of a single mention from the Planner-Identifier LLM response */
export interface PlannerMentionResponse {
  textSpans: string[];
  productId: string | null;
  brand: string;
  model: string;
  displayName: string;
  category: string;
  confidence: number;
  specs?: string[];
}

/** Raw shape of a single product from the Extractor LLM response */
export interface ExtractorProductResponse {
  index: number;
  quotes: Array<{
    text: string;
    sentiment: Sentiment;
  }>;
  intents: Intent[];
  overallSentiment: Sentiment;
  experience: ExperienceType;
  depth: Depth;
}
