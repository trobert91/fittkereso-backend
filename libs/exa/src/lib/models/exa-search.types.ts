/**
 * Exa API Search Types
 * Based on https://docs.exa.ai/reference
 */

export type ExaSearchType = 'auto' | 'neural' | 'keyword' | 'hybrid' | 'fast' | 'instant';

export interface ExaContentsOptions {
  /**
   * Get text content from results
   * Use max_characters to limit token usage
   */
  text?:
    | boolean
    | {
        maxCharacters?: number;
        includeHtmlTags?: boolean;
      };

  /**
   * Get highlighted snippets from results
   * More cost-effective than full text
   */
  highlights?:
    | boolean
    | {
        maxCharacters?: number;
        highlightsPerUrl?: number;
        query?: string;
      };

  /**
   * Get summary of the content
   */
  summary?: boolean | { query?: string };
}

export interface ExaSearchOptions {
  /**
   * Search query
   */
  query: string;

  /**
   * Number of results to return (1-20)
   * Default: 10
   */
  numResults?: number;

  /**
   * Search type
   * - auto: Balanced relevance and speed (~1 second)
   * - neural: Semantic/neural search (better for intent)
   * - keyword: Traditional keyword search
   * - hybrid: Combination of neural and keyword
   * - fast: Faster search with lower latency
   * - instant: Fastest search
   * Default: 'auto'
   */
  type?: ExaSearchType;

  /**
   * Content options
   */
  contents?: ExaContentsOptions;

  /**
   * Only include domains in results
   * Cannot be used with excludeDomains
   */
  includeDomains?: string[];

  /**
   * Exclude domains from results
   * Cannot be used with includeDomains
   */
  excludeDomains?: string[];

  /**
   * Filter by published date (end of range)
   * ISO 8601 format
   */
  endPublishedDate?: string;

  /**
   * Filter by published date (start of range)
   * ISO 8601 format
   */
  startPublishedDate?: string;

  /**
   * Maximum age of cached content in hours
   * - 24: Daily-fresh content
   * - 1: Near real-time
   * - 0: Always livecrawl
   * - -1: Never livecrawl (cache only)
   * - undefined: Default (livecrawl as fallback)
   */
  maxAgeHours?: number;

  /**
   * Category filter
   */
  category?:
    | 'company'
    | 'research paper'
    | 'news'
    | 'pdf'
    | 'tweet'
    | 'personal site'
    | 'financial report'
    | 'people';

  /**
   * Enable autoprompt to let Exa optimize the query
   * Default: false
   */
  useAutoprompt?: boolean;
}

export interface ExaSearchResult {
  /**
   * Result title
   */
  title: string;

  /**
   * Result URL
   */
  url: string;

  /**
   * Published date (ISO 8601)
   */
  publishedDate?: string;

  /**
   * Author name
   */
  author?: string;

  /**
   * Relevance score (0-1)
   */
  score?: number;

  /**
   * Result ID
   */
  id?: string;

  /**
   * Full text content (if requested)
   */
  text?: string;

  /**
   * Highlighted snippets (if requested)
   */
  highlights?: string[];

  /**
   * Summary (if requested)
   */
  summary?: string;
}

export interface ExaSearchResponse {
  /**
   * Array of search results
   */
  results: ExaSearchResult[];

  /**
   * Auto-generated date context (if autoprompt was enabled)
   */
  autoDate?: string;
}

/**
 * Options for getContents API call
 */
export interface ExaGetContentsOptions {
  /**
   * Content options (same as search)
   */
  text?:
    | true
    | {
        maxCharacters?: number;
        includeHtmlTags?: boolean;
      };

  highlights?:
    | true
    | {
        maxCharacters?: number;
        highlightsPerUrl?: number;
        query?: string;
      };

  summary?: true | { query?: string };
}

export interface ExaContentsResponse {
  /**
   * Array of content results
   */
  results: ExaSearchResult[];
}
