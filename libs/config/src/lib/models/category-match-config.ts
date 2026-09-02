export interface CategoryMatchConfig {
  strictness: 'strict' | 'moderate' | 'loose';
  numericTokenRules: Array<{
    pattern: RegExp;
    weight: number;
    description: string;
    critical: boolean;
  }>;
  matcherSpecHierarchies?: Record<string, Record<string, string[]>>;
  primarySpecs?: string[];
  matcherSpecs?: string[];
  maxMatcherSpecMismatches?: number;
  /** Per-spec numeric comparison overrides — see `CategoryMatchingConfig`. */
  specTolerances?: Record<string, { absolute?: number; percent?: number }>;
}
