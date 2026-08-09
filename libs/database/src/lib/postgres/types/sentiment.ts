export enum Sentiment {
  StrongPositive = 'strongPositive',
  Positive = 'positive',
  Neutral = 'neutral',
  Negative = 'negative',
  StrongNegative = 'strongNegative',
  Mixed = 'mixed',
}

export const POSITIVE_SENTIMENTS: ReadonlySet<Sentiment> = new Set([
  Sentiment.StrongPositive,
  Sentiment.Positive,
]);

export const NEGATIVE_SENTIMENTS: ReadonlySet<Sentiment> = new Set([
  Sentiment.StrongNegative,
  Sentiment.Negative,
]);

export const STRONG_SENTIMENTS: ReadonlySet<Sentiment> = new Set([
  Sentiment.StrongPositive,
  Sentiment.StrongNegative,
]);

export function isPositiveSentiment(sentiment: Sentiment | null | undefined): boolean {
  return sentiment != null && POSITIVE_SENTIMENTS.has(sentiment);
}

export function isNegativeSentiment(sentiment: Sentiment | null | undefined): boolean {
  return sentiment != null && NEGATIVE_SENTIMENTS.has(sentiment);
}

export function isStrongSentiment(sentiment: Sentiment | null | undefined): boolean {
  return sentiment != null && STRONG_SENTIMENTS.has(sentiment);
}

export enum Intent {
  Recommendation = 'recommendation',
  IssueReport = 'issue_report',
  Comparison = 'comparison',
  ExperienceReport = 'experience_report',
  Warning = 'warning',
  SeekingAdvice = 'seeking_advice',
  Question = 'question',
  ReputationReport = 'reputation_report',
}

export enum ExperienceType {
  Owner = 'owner',
  PriorOwner = 'prior_owner',
  Tested = 'tested',
  ProspectiveBuyer = 'prospective_buyer',
  Reference = 'reference',
}

export const HANDSON_EXPERIENCE_TYPES = new Set<ExperienceType>([
  ExperienceType.Owner,
  ExperienceType.PriorOwner,
  ExperienceType.Tested,
]);

export function isHandsonExperience(experience: ExperienceType): boolean {
  return HANDSON_EXPERIENCE_TYPES.has(experience);
}

export const HEARSAY_EXPERIENCE_TYPES = new Set<ExperienceType>([
  ExperienceType.ProspectiveBuyer,
  ExperienceType.Reference,
]);

export enum ExperienceBucket {
  FirstHand = 'firstHand',
  Speculative = 'speculative',
}

export const EXPERIENCE_BUCKET_TO_LEAVES: Record<ExperienceBucket, ExperienceType[]> = {
  [ExperienceBucket.FirstHand]: [
    ExperienceType.Owner,
    ExperienceType.PriorOwner,
    ExperienceType.Tested,
  ],
  [ExperienceBucket.Speculative]: [
    ExperienceType.ProspectiveBuyer,
    ExperienceType.Reference,
  ],
};

export function experienceLeavesForBucket(
  bucket: ExperienceBucket,
): ExperienceType[] {
  return EXPERIENCE_BUCKET_TO_LEAVES[bucket] ?? [];
}

export function expandExperienceFilters(
  values: ReadonlyArray<ExperienceBucket | ExperienceType | string>,
): ExperienceType[] {
  const expanded = new Set<ExperienceType>();
  for (const value of values) {
    const leaves = EXPERIENCE_BUCKET_TO_LEAVES[value as ExperienceBucket];
    if (leaves) {
      for (const leaf of leaves) expanded.add(leaf);
    } else {
      expanded.add(value as ExperienceType);
    }
  }
  return [...expanded];
}

export enum Depth {
  Comprehensive = 'comprehensive',
  Detailed = 'detailed',
  Mentioned = 'mentioned',
  Superficial = 'superficial',
}

const SHALLOW_DEPTHS = new Set<Depth>([Depth.Mentioned, Depth.Superficial]);

export function isHearsay(experience: ExperienceType, depth?: Depth): boolean {
  if (HEARSAY_EXPERIENCE_TYPES.has(experience)) {
    return SHALLOW_DEPTHS.has(depth ?? Depth.Superficial);
  }
  return false;
}
