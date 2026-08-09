export interface RedditSearchPlatformConfig {
  subreddits: string[];
  time: 'day' | 'week' | 'month' | 'year' | 'all';
  limit: number;
}

export interface CategorySearchConfig {
  /**
   * Hand-curated keyword examples shown to the LLM planner as inspiration.
   * NOT auto-searched — the planner decides which keywords to actually run
   * based on these patterns plus historical yield stats.
   */
  keywords: string[];

  platforms: {
    reddit?: RedditSearchPlatformConfig;
  };
}
