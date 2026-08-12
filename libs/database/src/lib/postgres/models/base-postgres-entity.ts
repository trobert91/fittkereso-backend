import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose } from 'class-transformer';
import {
  CreateDateColumn,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export class BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list] })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  @CreateDateColumn({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt?: Date;

  @Index()
  @Expose({ groups: [SerializeGroup.list] })
  @UpdateDateColumn({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt?: Date;
}
