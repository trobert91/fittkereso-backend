import { Column, Entity, ManyToOne } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Review } from './review.entity';

export enum ReviewFeedbackCategory {
  IncorrectProduct = 'incorrect_product',
  IrrelevantReview = 'irrelevant_review',
  OffensiveContent = 'offensive_content',
  Duplicate = 'duplicate',
  Other = 'other',
}

@Entity()
export class ReviewFeedback extends BasePostgresEntity {
  @ManyToOne(() => Review, { nullable: false, onDelete: 'CASCADE' })
  review: Review;

  @Column({ type: 'enum', enum: ReviewFeedbackCategory })
  category: ReviewFeedbackCategory;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ nullable: true })
  ipAddress?: string | null;
}
