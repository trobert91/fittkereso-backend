import { Entity, Column, Index } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';

export enum WebSearchProvider {
  DataForSEO = 'dataforseo',
  Exa = 'exa',
}

export interface WebSearchResult {
  title: string;
  url: string;
  description?: string;
  content?: string;
  publishedDate?: string;
}

@Entity('web_search_cache')
export class WebSearchCache extends BasePostgresEntity {
  // Normalized search keyword for similarity matching
  @Index()
  @Column({ type: 'text' })
  normalizedKeyword: string;

  // Original keyword (for debugging)
  @Column({ type: 'text' })
  originalKeyword: string;

  // Search date constraint (from comment.externalCreationTs)
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  searchDate?: Date;

  // Provider that generated these results
  @Column({
    type: 'enum',
    enum: WebSearchProvider,
    default: WebSearchProvider.DataForSEO,
  })
  provider: WebSearchProvider;

  // Cached search results (JSON)
  @Column({ type: 'jsonb' })
  results: WebSearchResult[];

  // Cache metadata
  @Column({ type: 'int', default: 0 })
  hitCount: number;

  @Column({ type: 'timestamptz' })
  lastAccessedAt: Date;

  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
