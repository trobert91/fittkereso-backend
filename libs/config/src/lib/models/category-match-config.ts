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
}
