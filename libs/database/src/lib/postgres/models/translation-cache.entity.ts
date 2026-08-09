import { Column, Entity, Index, Unique } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';

export type TranslationCacheSource = 'llm' | 'manual';

@Entity('translation_cache')
@Unique('UQ_translation_cache_lang_text', [
  'sourceLanguage',
  'targetLanguage',
  'sourceText',
])
export class TranslationCache extends BasePostgresEntity {
  @Index()
  @Column({ type: 'text' })
  sourceLanguage: string;

  @Index()
  @Column({ type: 'text' })
  targetLanguage: string;

  // Lowercased + trimmed source text — this is the lookup key.
  @Index()
  @Column({ type: 'text' })
  sourceText: string;

  @Column({ type: 'text' })
  translatedText: string;

  // 'llm' | 'manual' — dictionary hits are NOT cached (they live in config).
  @Column({ type: 'text' })
  source: TranslationCacheSource;

  @Column({ type: 'text', nullable: true })
  model?: string;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0 })
  costInDollars: number;

  @Column({ type: 'int', default: 0 })
  hitCount: number;

  @Column({ type: 'timestamptz' })
  lastAccessedAt: Date;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date;
}
