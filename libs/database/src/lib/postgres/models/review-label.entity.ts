import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Review } from './review.entity';
import { Sentiment } from '../types/sentiment';

export enum ReviewLabelType {
  Feature = 'feature',
  UseCase = 'useCase',
  Issue = 'issue',
}

@Entity()
@Unique(['review', 'type', 'label'])
@Index(['review', 'type'])
export class ReviewLabel extends BasePostgresEntity {
  @ManyToOne(() => Review, (review) => review.labels, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  review: Review;

  @Column({ type: 'enum', enum: ReviewLabelType })
  type: ReviewLabelType;

  @Column()
  label: string;

  @Column({ type: 'enum', enum: Sentiment })
  sentiment: Sentiment;

  /** Number of supporting evidence entries (quote-level + ref-level) that
   *  contributed to this consolidated label. Reflects evidence density, NOT
   *  a weighting input for downstream rating math (the rating service buckets
   *  by user, not by count). */
  @Column({ type: 'int', default: 1 })
  evidenceCount: number;
}
