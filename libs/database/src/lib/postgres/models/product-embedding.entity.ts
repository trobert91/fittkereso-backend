import { BeforeInsert, BeforeUpdate, Column, Entity, OneToOne } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductModel } from './product-model.entity';

@Entity({ synchronize: false })
export class ProductEmbedding extends BasePostgresEntity {
  @OneToOne(() => ProductModel, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  model?: ProductModel;

  @Column({
    type: 'vector' as any,
    nullable: false,
    length: 1536,
    select: false,
  })
  embedding?: number[];

  @BeforeUpdate()
  @BeforeInsert()
  stringifyVector() {
    // Convert number array to string format, so that Postgres understands it as a vector
    // e.g. '[0.9, 0.1, 0.7]'
    if (this.embedding && Array.isArray(this.embedding)) {
      this.embedding = JSON.stringify(this.embedding) as any;
    }
  }
}
