import { ContactStatusEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseModel } from './base-model';
import { UserEntity } from './user.entity';

@Entity('contacts')
@Unique(['userId', 'contactId'])
@Index(['userId', 'status'])
@Index(['contactId', 'status'])
export class ContactEntity extends BaseModel {
  @Column({ type: 'varchar', length: 36 })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 36 })
  contactId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'contactId' })
  contactUser: UserEntity;

  @Column({
    type: 'enum',
    enum: ContactStatusEnum,
    default: ContactStatusEnum.PENDING_SENT,
  })
  status: ContactStatusEnum;

  @Column({ type: 'varchar', length: 255, nullable: true })
  alias: string | null;
}
